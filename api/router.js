// Minimal router: [method, pattern, handler] tuples with ":param" segments.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** {handler, params} for the first route matching `method` and `pathname`, or null. */
export function matchRoute(routes, method, pathname) {
  const pathParts = pathname.split('/');
  for (const [routeMethod, pattern, handler] of routes) {
    if (routeMethod !== method) continue;
    const patternParts = pattern.split('/');
    if (patternParts.length !== pathParts.length) continue;

    const params = {};
    const matches = patternParts.every((part, i) => {
      if (!part.startsWith(':')) return part === pathParts[i];
      params[part.slice(1)] = decodePathPart(pathParts[i]);
      return true;
    });
    if (matches) return { handler, params };
  }
  return null;
}

function decodePathPart(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new HttpError(400, 'Malformed URL');
  }
}
