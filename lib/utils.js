export function dayKey(date = new Date()) {
    // local-day boundary
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 10);
}

export async function parseFormBody(req) {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', (chunk) => (data += chunk));
        req.on('end', () =>
            resolve(Object.fromEntries(new URLSearchParams(data)))
        );
    });
}
