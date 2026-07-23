import { handleOmega } from "../_handler.js"

// GET /menu/{customerid} → full menu JSON ({ branch, categories, menu, sd_menus })
export default (req, res) => handleOmega(req, res, "getRestaurantMenu")
