#!/usr/bin/env node
function macosMachOArchitectureForNodeArch(nodeArch) {
  if (nodeArch === "arm64") return "arm64";
  if (nodeArch === "x64") return "x86_64";
  return null;
}

function macosHelperArchitecturesMatchNodeArch(architectures, nodeArch) {
  const expected = macosMachOArchitectureForNodeArch(nodeArch);
  return !!expected
    && Array.isArray(architectures)
    && architectures.length === 1
    && architectures[0] === expected;
}

module.exports = {
  macosMachOArchitectureForNodeArch,
  macosHelperArchitecturesMatchNodeArch
};
