export class HttpError extends Error {
  constructor (status, message, extra = {}) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    Object.assign(this, extra)
  }
}

export function httpError (status, message, extra) {
  return new HttpError(status, message, extra)
}
