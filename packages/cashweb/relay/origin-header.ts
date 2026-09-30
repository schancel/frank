/**
 * The relay's `PUT /metadata/:addr` requires an `Origin` header (`RelayInfo::parse_from_headers`
 * fails the request with `MissingOrigin` otherwise), but `Origin` is a forbidden header name for
 * scripts: a browser (axios' XHR adapter) refuses to set it, logs `Refused to set unsafe header
 * "Origin"` on every call, and sends the page's real origin instead (ticket #278). So the header is
 * only set explicitly where nothing else will send one (Node: the bots and tests); in a browser
 * context the browser's own `Origin` satisfies the relay's requirement.
 */
export function relayOriginHeader(nodeOrigin: string): { Origin?: string } {
  // axios (0.x) picks its XHR adapter exactly when `XMLHttpRequest` exists.
  return typeof XMLHttpRequest === 'undefined' ? { Origin: nodeOrigin } : {}
}
