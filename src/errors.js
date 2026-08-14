export class QosError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "QosError";
    this.code = code;
    this.details = details;
  }
}

export function assertQos(condition, code, message, details = undefined) {
  if (!condition) {
    throw new QosError(code, message, details);
  }
}

export function publicError(error) {
  if (error instanceof QosError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }
  return {
    error: {
      code: "INTERNAL_ERROR",
      message: "The request failed closed",
    },
  };
}
