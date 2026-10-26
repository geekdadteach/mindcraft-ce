// Retry only ordinary path-computation failures.
// A player interruption, superseded action or stop is never retried.

export function isRetryablePathError(error) {
    const name = String(error?.name || '');
    const message = String(error?.message || error || '');

    return name === 'NoPath'
        || name === 'Timeout'
        || /^(No path to the goal!|Took to long to decide path to goal!)/i.test(message);
}

export async function retryPathfinding(
    bot,
    navigate,
    {
        maxAttempts = 2,
        onRetry = () => {},
        targetGoal = null
    } = {}
) {
    if (!bot || typeof navigate !== 'function')
        throw new TypeError('A bot and navigation function are required');

    if (!Number.isSafeInteger(maxAttempts)
        || maxAttempts < 1 || maxAttempts > 2)
        throw new RangeError('Navigation attempts must be 1 or 2');

    const generation = bot._actionGen;
    const previousDepth = bot._bobBrainLocalRetryDepth || 0;

    // While a local retry is active, intermediate Mineflayer
    // path events are not Brain incidents.
    bot._bobBrainLocalRetryDepth = previousDepth + 1;

    const interrupted = () =>
        bot.interrupt_code === true ||
        (generation !== undefined &&
         bot._actionGen !== generation);

    try {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (interrupted())
                return false;

            try {
                await navigate();
                return true;
            } catch (error) {
                if (!isRetryablePathError(error) ||
                    interrupted())
                    throw error;

                if (attempt === maxAttempts) {
                    // One terminal notification, not one per retry.
                    if (targetGoal &&
                        typeof bot.emit === 'function') {
                        try {
                            bot.emit('bob_path_terminal_failure', {
                                goal: targetGoal,
                                error
                            });
                        } catch (_) {
                            // Reporting never changes gameplay.
                        }
                    }
                    throw error;
                }

                onRetry(attempt, error);
            }
        }
    } finally {
        if (previousDepth)
            bot._bobBrainLocalRetryDepth = previousDepth;
        else
            delete bot._bobBrainLocalRetryDepth;
    }

    return false;
}
