export function isTokenValid(req, expected) {
    if (!expected) return false;

    // If running on Next.js / Vercel API, req.query is usually populated
    if (req.query && typeof req.query.token === 'string') {
        return req.query.token.trim() === expected.trim();
    }

    // Fallback: manually parse URL (works in plain Node handlers too)
    try {
        const url = new URL(
            req.url,
            `http://${req.headers.host || 'localhost'}`
        );
        const val = url.searchParams.get('token');
        return val && val.trim() === expected.trim();
    } catch {
        return false;
    }
}

export function isValidMethod(req) {
    if (!req.method) return false;
    const method = req.method.toUpperCase();
    return method === 'GET' || method === 'POST';
}
