module.exports = function collect(...values) {
  return { count: values.length, values };
};
