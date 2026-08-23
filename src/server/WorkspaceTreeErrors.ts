/** HTTP-aware errors shared by the hosted workspace tree service and route. */
export class WorkspaceTreeHttpError extends Error {
  constructor(
    public readonly statusCode: 400 | 410,
    message: string
  ) {
    super(message);
    this.name = "WorkspaceTreeHttpError";
  }
}

export class WorkspaceTreeBadRequestError extends WorkspaceTreeHttpError {
  constructor(message: string) {
    super(400, message);
    this.name = "WorkspaceTreeBadRequestError";
  }
}

export class WorkspaceTreeExpiredError extends WorkspaceTreeHttpError {
  constructor(message = "Workspace directory listing has expired") {
    super(410, message);
    this.name = "WorkspaceTreeExpiredError";
  }
}
