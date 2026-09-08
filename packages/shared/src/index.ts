export const VERSION = "0.0.1";

export { type Client, connect, RpcError } from "./client";
export {
  DATA_DIR_NAME,
  DB_FILE,
  dataPaths,
  findRepoRoot,
  resolveDataDir,
  SOCKET_FILE,
} from "./paths";
export { PHASES, type Phase, type PhaseDef } from "./phases";
export {
  type ActivityNotification,
  ERROR_CODES,
  encodeLine,
  type HelloParams,
  type HelloResult,
  type JsonRpcError,
  type JsonRpcRequest,
  type JsonRpcResponse,
  LineDecoder,
  LineTooLongError,
  MAX_LINE_BYTES,
  METHOD_NAMES,
  type MethodName,
  type Methods,
  type Params,
  PROTOCOL_VERSION,
  type ProtocolErrorCode,
  type RequestId,
  type Result,
} from "./protocol";
export {
  type Activity,
  type ActivityEvent,
  type ActivityType,
  BODY_MAX_BYTES,
  BRANCH_MAX_BYTES,
  type Card,
  type CardDetail,
  type CardRefs,
  COMMENT_MAX_BYTES,
  COMMITS_MAX_COUNT,
  MEMBER_NAME_MAX_BYTES,
  type Member,
  type MemberKind,
  PR_URL_MAX_BYTES,
  TITLE_MAX_BYTES,
} from "./types";
