function createScanSequence() {
  let current = 0;
  return {
    begin: () => ++current,
    isCurrent: (sequence) => sequence === current,
  };
}

module.exports = { createScanSequence };
