export class ClientError extends Error {
  constructor(message) { super(message); this.name = 'ClientError'; this.statusCode = 400 }
}

export class UnauthorizedError extends Error {
  constructor(message) { super(message); this.name = 'UnauthorizedError'; this.statusCode = 401 }
}

export class ForbiddenError extends Error {
  constructor(message) { super(message); this.name = 'ForbiddenError'; this.statusCode = 403 }
}

export class PayloadTooLargeError extends Error {
  constructor(message) { super(message); this.name = 'PayloadTooLargeError'; this.statusCode = 413 }
}

export class UpstreamUnavailableError extends Error {
  constructor(message) { super(message); this.name = 'UpstreamUnavailableError'; this.statusCode = 502 }
}

export class ServerError extends Error {
  constructor(message) { super(message); this.name = 'ServerError'; this.statusCode = 500 }
}