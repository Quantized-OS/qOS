import { QosError } from "./errors.js";

function normalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new QosError("NON_CANONICAL_VALUE", "Only plain objects can be canonically encoded");
    }
    // A null prototype prevents a JSON key named "__proto__" from mutating
    // the object being assembled and silently disappearing from the encoding.
    const output = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      output[key] = normalize(value[key]);
    }
    return output;
  }
  throw new QosError("NON_CANONICAL_VALUE", "Value cannot be canonically encoded");
}

export function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

export function hasExactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, i) => key === wanted[i]);
}
