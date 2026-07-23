/**
 * Omega oMenu fetch helper — ported verbatim from sync/sync.js → fetchOmegaMenu().
 *
 * Does the Laravel auth dance server-side (browsers can't):
 *   1. GET the public menu page to collect session + XSRF cookies
 *   2. POST the target endpoint with the Cookie header + URL-decoded x-xsrf-token
 *
 * Kept deliberately dumb — a raw pass-through proxy. The plugin does the transform.
 */

const OMEGA_BASE = "https://menu.omegasoftware.ca"
const UA = "Mozilla/5.0 (compatible; MenuSync/1.0)"

export class OmegaError extends Error {
    constructor(status, message) {
        super(message)
        this.status = status
    }
}

/**
 * @param {"getRestaurantMenu"|"getRestaurantData"} endpoint
 * @param {string} customerid
 * @returns {Promise<any>} parsed JSON from Omega
 */
export async function fetchOmega(endpoint, customerid) {
    // Bootstrap: load the page to collect Laravel session + XSRF cookies
    const pageRes = await fetch(`${OMEGA_BASE}/${customerid}`, {
        headers: { "user-agent": UA },
    })
    if (!pageRes.ok) {
        throw new OmegaError(502, `Omega page load failed: ${pageRes.status} (bad customerid?)`)
    }

    const setCookies = pageRes.headers.getSetCookie?.() ?? []
    const cookieJar = {}
    for (const c of setCookies) {
        const [pair] = c.split(";")
        const eq = pair.indexOf("=")
        if (eq > 0) cookieJar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
    }
    const cookieHeader = Object.entries(cookieJar)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ")
    // Laravel expects the XSRF-TOKEN cookie URL-decoded in the x-xsrf-token header
    const xsrf = cookieJar["XSRF-TOKEN"] ? decodeURIComponent(cookieJar["XSRF-TOKEN"]) : ""

    const res = await fetch(`${OMEGA_BASE}/${endpoint}`, {
        method: "POST",
        headers: {
            accept: "application/json, text/plain, */*",
            "content-type": "application/json;charset=UTF-8",
            origin: OMEGA_BASE,
            referer: `${OMEGA_BASE}/${customerid}`,
            cookie: cookieHeader,
            ...(xsrf ? { "x-xsrf-token": xsrf } : {}),
            "user-agent": UA,
        },
        body: JSON.stringify({ customerid, has_table: 0 }),
    })

    const body = await res.text()
    if (!res.ok) {
        throw new OmegaError(502, `${endpoint} failed: ${res.status}`)
    }
    // A bad slug makes Omega serve the Angular HTML shell instead of JSON.
    try {
        return JSON.parse(body)
    } catch {
        throw new OmegaError(502, `Omega returned non-JSON for "${customerid}" (unknown customerid?)`)
    }
}
