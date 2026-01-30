# Coding Style

## Immutability (CRITICAL)
ALWAYS create new objects, NEVER mutate:

// WRONG
prices.push(newPrice);
position.size += delta;

// CORRECT
const updatedPrices = [...prices, newPrice];
const updatedPosition = { ...position, size: position.size + delta };

## File Organization
- 200-400 lines typical, 800 max
- One responsibility per file
- Group by feature (fetchers/, engine/)

## Naming Conventions
- Timestamps: startTime, endTime, timestamp (Unix ms)
- Prices: btcPrice, strikePrice, finalPrice (USD)
- Rates: volatility, annualizedVol (decimal 0.60, not percentage 60%)

## No Debug Code in Production
- NO console.log — use structured logging
- NO commented-out code blocks
- NO TODO without ticket/issue reference

## Error Messages
Include context: what failed, what was expected, what was received
BAD: "Error fetching data"
GOOD: "Chainlink fetch failed: round 12345 returned 0 price at 2025-01-30T14:00:00Z"