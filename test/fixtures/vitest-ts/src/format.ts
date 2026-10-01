export function formatMoney(value, currency) {
  const symbol = currency === 'EUR' ? '€' : '$';
  return `${symbol}${value.toFixed(2)}`;
}

export function formatName(first, last) {
  if (!first) return last;
  if (!last) return first;
  return `${first} ${last}`;
}

