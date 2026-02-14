/**
 * Train/Test Split — Chronological date split for optimizer validation.
 *
 * 70/30 split by default. No shuffle, no randomness — purely chronological.
 * Returns two date ranges that partition the input range.
 */

export interface DateSplit {
    readonly trainStart: Date;
    readonly trainEnd: Date;
    readonly testStart: Date;
    readonly testEnd: Date;
    readonly trainDays: number;
    readonly testDays: number;
}

/**
 * Split a date range chronologically into train and test periods.
 *
 * @param startDate - Start of the full range
 * @param endDate - End of the full range
 * @param trainRatio - Fraction of data for training (default 0.70)
 * @returns DateSplit with train and test date ranges
 */
export function splitDateRange(
    startDate: Date,
    endDate: Date,
    trainRatio: number = 0.70
): DateSplit {
    const totalMs = endDate.getTime() - startDate.getTime();
    if (totalMs <= 0) {
        throw new Error(`Invalid date range: ${startDate.toISOString()} to ${endDate.toISOString()}`);
    }
    if (trainRatio <= 0 || trainRatio >= 1) {
        throw new Error(`trainRatio must be in (0, 1), got ${trainRatio}`);
    }

    const trainMs = Math.floor(totalMs * trainRatio);
    const splitPoint = new Date(startDate.getTime() + trainMs);

    const trainDays = trainMs / (24 * 60 * 60 * 1000);
    const testDays = (totalMs - trainMs) / (24 * 60 * 60 * 1000);

    return {
        trainStart: startDate,
        trainEnd: splitPoint,
        testStart: splitPoint,
        testEnd: endDate,
        trainDays: Math.round(trainDays * 10) / 10,
        testDays: Math.round(testDays * 10) / 10,
    };
}
