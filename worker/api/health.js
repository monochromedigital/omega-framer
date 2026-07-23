// GET /health → liveness check for uptime monitoring.
// Deliberately does NOT call Omega, so it stays fast/cheap and only reflects whether the worker
// itself is up. Monitor /menu/{id} separately for full end-to-end coverage (that path is cached,
// so 5-min pings mostly hit the edge cache and don't hammer Omega).
export default (req, res) => {
    res.setHeader("Cache-Control", "no-store")
    res.status(200).json({ ok: true, service: "omega-menu-worker", time: new Date().toISOString() })
}
