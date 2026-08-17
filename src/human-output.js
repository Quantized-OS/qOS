function labelFor(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/Id\b/g, "ID")
    .replace(/Url\b/g, "URL")
    .replace(/Rpc\b/g, "RPC")
    .replace(/Qos\b/g, "qOS")
    .replace(/^./, (character) => character.toUpperCase());
}

function scalar(value) {
  if (value === null) return "Not configured";
  if (value === true) return "Yes";
  if (value === false) return "No";
  return String(value);
}

function renderObject(value, lines, indent) {
  for (const [key, item] of Object.entries(value)) {
    const prefix = " ".repeat(indent);
    const label = labelFor(key);
    if (Array.isArray(item)) {
      if (item.length === 0) {
        lines.push(`${prefix}${label}: (none)`);
      } else if (item.every((entry) => entry === null || typeof entry !== "object")) {
        if (["blockers", "nextSteps"].includes(key)) {
          lines.push(`${prefix}${label}:`);
          for (const entry of item) lines.push(`${prefix}  - ${scalar(entry)}`);
        } else {
          lines.push(`${prefix}${label}: ${item.map(scalar).join(", ")}`);
        }
      } else {
        lines.push(`${prefix}${label}:`);
        for (const entry of item) {
          lines.push(`${prefix}  -`);
          renderObject(entry, lines, indent + 4);
        }
      }
    } else if (item && typeof item === "object") {
      lines.push(`${prefix}${label}:`);
      renderObject(item, lines, indent + 2);
    } else {
      lines.push(`${prefix}${label}: ${scalar(item)}`);
    }
  }
}

export function formatHuman(value, { title = undefined } = {}) {
  const lines = [];
  if (title) {
    lines.push(title, "-".repeat(title.length));
  }
  if (Array.isArray(value)) {
    if (value.length === 0) lines.push("(none)");
    for (const entry of value) {
      lines.push("-");
      if (entry && typeof entry === "object") renderObject(entry, lines, 2);
      else lines.push(`  ${scalar(entry)}`);
    }
  } else if (value && typeof value === "object") {
    renderObject(value, lines, 0);
  } else {
    lines.push(scalar(value));
  }
  return `${lines.join("\n")}\n`;
}

export function writeResult(value, { json = false, title = undefined } = {}) {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : formatHuman(value, { title }));
}
