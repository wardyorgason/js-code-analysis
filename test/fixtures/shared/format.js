function formatMoney(value, currency) {
  const symbol = currency === 'EUR' ? '€' : '$';
  return `${symbol}${value.toFixed(2)}`;
}

function formatName(first, last) {
  if (!first) return last;
  if (!last) return first;
  return `${first} ${last}`;
}

module.exports = { formatMoney, formatName };
