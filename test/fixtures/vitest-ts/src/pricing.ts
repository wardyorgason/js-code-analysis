// Deliberately branchy so FTA and coverage both have something to say.
export function priceFor(order, customer, promo, region, now) {
  let total = 0;
  for (const item of order.items) {
    if (item.qty <= 0) continue;
    let p = item.price * item.qty;
    if (item.category === 'food') {
      if (region === 'EU') p *= 1.07;
      else if (region === 'US') p *= 1.05;
      else p *= 1.1;
    } else if (item.category === 'books') {
      if (region !== 'US') p *= 1.02;
    } else {
      p *= region === 'EU' ? 1.2 : region === 'US' ? 1.08 : 1.15;
    }
    if (customer && customer.vip) {
      if (customer.years > 5) p *= 0.85;
      else if (customer.years > 2) p *= 0.9;
      else p *= 0.95;
    }
    total += p;
  }
  if (promo) {
    switch (promo.type) {
      case 'percent':
        total *= 1 - promo.value / 100;
        break;
      case 'fixed':
        total = Math.max(0, total - promo.value);
        break;
      case 'bogo':
        if (order.items.length > 1) total -= Math.min(...order.items.map((i) => i.price));
        break;
      default:
        break;
    }
  }
  if (now && now.getDay && (now.getDay() === 0 || now.getDay() === 6) && total > 100) total -= 5;
  return Math.round(total * 100) / 100;
}

export function shippingFor(total, region, express) {
  if (total > 200) return 0;
  if (express) return region === 'EU' ? 25 : 20;
  return region === 'EU' ? 10 : 8;
}

