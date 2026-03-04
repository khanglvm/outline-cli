export class CliError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CliError";
    this.details = details;
  }
}

export class ApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ApiError";
    this.details = details;
  }
}
