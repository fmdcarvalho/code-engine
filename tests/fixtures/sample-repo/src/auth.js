export function authenticateUser(request) {
  const token = request.headers.authorization;
  if (!token) {
    throw new Error("missing auth token");
  }
  return verifyJwtToken(token);
}

export function verifyJwtToken(token) {
  return token.startsWith("Bearer ");
}
