// Recognize natural log/stem block names without freezing the biome wood list.
export function isNaturalWoodBlockName(name) {
  const text = String(name || '');
  return !text.startsWith('stripped_') &&
    (/_log$/.test(text) || /_stem$/.test(text) || text === 'bamboo');
}
export function availableWoodNames(blocksArray = []) {
  return [...new Set(blocksArray.filter(b => b && isNaturalWoodBlockName(b.name)).map(b => b.name))];
}
