export const ORDER_SELECT = `
SELECT o.*, r.name AS restaurant_name, r.address AS restaurant_address, r.phone AS restaurant_phone,
  u.name AS customer_name, rd.name AS rider_name, rd.phone AS rider_phone,
  CASE WHEN o.status IN ('ready','picked_up') THEN rl.lat END AS rider_lat,
  CASE WHEN o.status IN ('ready','picked_up') THEN rl.lng END AS rider_lng,
  CASE WHEN o.status IN ('ready','picked_up') THEN rl.updated_at END AS rider_seen_at,
  COALESCE((SELECT json_agg(json_build_object('name',oi.name,'price',oi.price,'quantity',oi.quantity))
            FROM order_items oi WHERE oi.order_id=o.id),'[]'::json) AS items
FROM orders o
JOIN restaurants r ON r.id=o.restaurant_id
JOIN users u ON u.id=o.customer_id
LEFT JOIN users rd ON rd.id=o.rider_id
LEFT JOIN rider_locations rl ON rl.rider_id=o.rider_id`;
