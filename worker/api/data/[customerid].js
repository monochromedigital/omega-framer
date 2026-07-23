import { handleOmega } from "../_handler.js"

// GET /data/{customerid} → branch/brand info (name, address, phones, socials, currency)
export default (req, res) => handleOmega(req, res, "getRestaurantData")
