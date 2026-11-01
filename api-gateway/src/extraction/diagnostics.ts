// Provider messages and nested causes can contain credentials or model content.
// Export only fixed identifiers and numeric HTTP status codes.
export type FailureDiagnostic = { name: string | null; code: string | null; httpStatus: number | null };

const names = new Set([
  "AbortError", "TimeoutError", "CredentialsProviderError", "AccessDeniedException", "UnrecognizedClientException",
  "ExpiredTokenException", "ValidationException", "ResourceNotFoundException", "ThrottlingException",
  "ServiceQuotaExceededException", "ModelNotReadyException", "ServiceUnavailableException", "InternalServerException",
]);
const codes = new Set([
  "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID",
]);

export function describeFailure(error: unknown): FailureDiagnostic {
  const result: FailureDiagnostic = { name: null, code: null, httpStatus: null };
  const visited = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object" && !visited.has(current); depth++) {
    visited.add(current);
    const value = current as { name?: unknown; code?: unknown; statusCode?: unknown; cause?: unknown; $metadata?: { httpStatusCode?: unknown } };
    if (!result.name && typeof value.name === "string" && names.has(value.name)) result.name = value.name;
    if (!result.code && typeof value.code === "string" && codes.has(value.code)) result.code = value.code;
    const status = value.$metadata?.httpStatusCode ?? value.statusCode;
    if (result.httpStatus === null && typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) result.httpStatus = status;
    current = value.cause;
  }
  return result;
}
