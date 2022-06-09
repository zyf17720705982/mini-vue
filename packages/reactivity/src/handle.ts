import { readonly, track, trigger } from "./";
import { reactive } from "./";
import { ITERATR_KEY } from "./";

// 单独作为 map.keys() 追踪依赖时的键
export const MAP_KEY_ITERATE_KEY = Symbol();

// 数组的代理对象
const arrayInstrumentations = {};

["includes", "indexOf", "lastIndexOf"].forEach((method) => {
  const originMethod = Array.prototype[method];
  arrayInstrumentations[method] = function (...args) {
    // this是代理对象，先在代理对象中查找，储存结果在res中
    let res = originMethod.apply(this, args);
    if (res === false || res === -1) {
      // 如果没有的话就通过this.raw拿到原始数组，再去其中查找并更新res的值
      res = originMethod.apply(this.raw, args);
    }
    return res;
  };
});
// 标记是否可以追踪
export let shouldTrack = true;
["push", "pop", "shift", "unshift", "splice"].forEach((method) => {
  const originMethod = Array.prototype[method];
  arrayInstrumentations[method] = function (...args) {
    shouldTrack = false;
    // push 方法的默认行为
    let res = originMethod.apply(this, args);
    shouldTrack = true;
    return res;
  };
});

export function createReactive(
  obj: object,
  isShallow = false,
  isReadonly = false
) {
  return new Proxy(obj, {
    get(target, key, receiver) {
      if (key === "raw") {
        return target;
      }

      // 如果操作对象是数组并且key存在于arrayInstrumentations中，则执行相应的方法
      // 返回的是定义在arrayInstrumentations上的值
      if (Array.isArray(target) && arrayInstrumentations.hasOwnProperty(key)) {
        return Reflect.get(arrayInstrumentations, key, receiver);
      }
      // 非只读时才建立响应关系
      if (!isReadonly && typeof key !== "symbol") {
        track(target, key);
      }
      const res = Reflect.get(target, key, receiver);

      // 如果是使用shallowReactive第一层就直接返回res
      if (isShallow) {
        return res;
      }
      // 如果是使用reactive代理的就递归代理深层对象
      if (typeof res === "object" && res !== null) {
        return isReadonly ? readonly(res) : reactive(res);
      }
      return res;
    },
    set(target, key, value, receiver) {
      if (isReadonly) {
        console.warn(`${key.toString()} 是只读的`);
        return true;
      }
      // 旧值
      const oldValue = target[key];
      // 如果属性不存在，则说明是添加新属性，否则是设置已有属性
      const type = Array.isArray(target)
        ? Number(key) < target.length
          ? "SET"
          : "ADD"
        : Object.prototype.hasOwnProperty.call(target, key)
        ? "SET"
        : "ADD";
      // 当对象新增属性时，触发响应函数
      const res = Reflect.set(target, key, value, receiver);
      // 如果receiver是target的代理对象就执行
      if (target === receiver.raw) {
        // 只有当值真正发生变化时才触发副作用函数,并且都不是NaN的情况下才触发
        if (oldValue !== value && (oldValue === oldValue || value === value)) {
          trigger(target, key, type, value);
        }
      }

      return res;
    },
    // 代理对象的delete方法
    deleteProperty(target, key) {
      // 如果是只读的，就警告
      if (isReadonly) {
        console.warn(`${key.toString()} 是只读的`);
        return true;
      }
      // 检查备操作属性是否是对象自己的属性
      const hadKey = Object.prototype.hasOwnProperty.call(target, key);
      const res = Reflect.deleteProperty(target, key);
      // 只有当被删除的属性是对象自己的属性时才触发副作用函数
      if (res && hadKey) {
        trigger(target, key, "DELETE");
      }
      return res;
    },
    // 拦截in操作符
    has(target, key) {
      return Reflect.has(target, key);
    },
    // 拦截for...in循环
    ownKeys(target) {
      track(target, Array.isArray(target) ? "length" : ITERATR_KEY);
      return Reflect.ownKeys(target);
    },
  });
}
// 处理set和map
const mutableInstrumentations = {
  add(key) {
    // 通过this代理对象上的raw属性获取原始数据对象
    const target = this.raw;
    // 先判断是否已经存在
    const hadKey = target.has(key);
    // 通过原始数据对象执行add方法
    const res = target.add(key);
    if (!hadKey) {
      // 触发响应
      trigger(target, key, "ADD");
    }
    return res;
  },
  delete(key) {
    const target = this.raw;
    const hadKey = target.has(key);
    const res = target.delete(key);
    // 当元素存在时才触发响应
    if (hadKey) {
      trigger(target, key, "DELETE");
    }
    return res;
  },
  get(key) {
    const target = this.raw;
    const had = target.has(key);
    track(target, key);
    // 如果存在就返回结果，如果得到的结果是可代理的数据，就返回用reactive代理的数据
    if (had) {
      const res = target.get(key);
      return typeof res === "object" ? reactive(res) : res;
    }
  },
  set(key, value) {
    const target = this.raw;

    const had = target.has(key);
    // 旧值
    const oldValue = target.get(key);
    // 获取原始数据，如果value.raw不存在，则直接使用value
    const rawValue = value.raw || value;
    // 设置新值
    target.set(key, rawValue);
    if (!had) {
      trigger(target, key, "ADD");
    } else if (
      oldValue !== value ||
      (oldValue === oldValue && value === value)
    ) {
      // 如果不存在，并且值变了，就是set类型操作，意味着修改了值
      trigger(target, key, "SET");
    }
  },
  forEach(callback, thisArg) {
    // 转换成响应式数据
    const wrap = (val) => (typeof val === "object" ? reactive(val) : val);
    // 获取原始对象
    const target = this.raw;
    track(target, ITERATR_KEY);
    // 调用方法，并且转换成响应式数据
    target.forEach((v, k) => {
      callback.call(thisArg, wrap(v), wrap(k), this);
    });
  },
  [Symbol.iterator]: iterationMethod,
  entries: iterationMethod,
  values: valuesIterationMethod,
  keys: keysIterationMethod,
};

export function createReactiveSetOrMap(
  obj,
  isShallow = false,
  isReadonly = false
) {
  return new Proxy(obj, {
    get(target, key, receiver) {
      if (key === "raw") return target;
      if (key === "size") {
        track(target, ITERATR_KEY);
        return Reflect.get(target, key, target);
      }
      // 返回重写的方法
      return mutableInstrumentations[key];
    },
  });
}
// 迭代方法
function iterationMethod() {
  const target = this.raw;
  const itr = target[Symbol.iterator]();
  const wrap = (val) => (typeof val === "object" ? reactive(val) : val);
  track(target, ITERATR_KEY);
  return {
    next() {
      //  调用原始对象的迭代器获取value 和 done
      const { value, done } = itr.next();
      return {
        // 如果value不是空的就转换成响应式数据
        value: value ? [wrap(value[0]), wrap(value[1])] : value,
        done,
      };
    },
    // 实现可迭代协议
    [Symbol.iterator]() {
      return this;
    },
  };
}

function valuesIterationMethod() {
  const target = this.raw;
  const itr = target.values();
  const wrap = (val) => (typeof val === "object" ? reactive(val) : val);
  track(target, ITERATR_KEY);
  return {
    next() {
      const { value, done } = itr.next();
      return {
        value: wrap(value),
        done,
      };
    },
    [Symbol.iterator]() {
      return this;
    },
  };
}

function keysIterationMethod() {
  const target = this.raw;
  const itr = target.keys();
  const wrap = (val) => (typeof val === "object" ? reactive(val) : val);
  // 副作用函数与MAP_KEY_ITERATE_KEY建立响应关系
  track(target, MAP_KEY_ITERATE_KEY);

  return {
    next() {
      const { value, done } = itr.next();
      return {
        value: wrap(value),
        done,
      };
    },
    [Symbol.iterator]() {
      return this;
    },
  };
}
