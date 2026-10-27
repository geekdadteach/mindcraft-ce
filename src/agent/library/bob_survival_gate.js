// Guard model-selected optional actions during critical survival states.
// This intentionally does not interrupt an already-running action (the modes handle that).
const PERMITTED = new Set(['!getFood', '!consume', '!eat', '!stop', '!stfu', '!stay', '!goToBed',
  '!endGoal', '!inventory', '!stats', '!health', '!goal']);
export function criticalSurvivalGuard(bot, commandName, isAutonomous = true) {
  if (!isAutonomous || !bot || !Number.isFinite(bot.health) || !Number.isFinite(bot.food)) return null;
  if (bot.health > 4 && bot.food > 3) return null;
  if (PERMITTED.has(commandName)) return null;
  return 'CRITICAL SURVIVAL: health=' + Math.round(bot.health) + '/20, food=' + Math.round(bot.food) +
    '/20. Optional action blocked. Prioritize !getFood, eating immediately, or safe shelter. Do not mine, build or explore until stabilized.';
}
