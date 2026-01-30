# Financial Code Rules (MANDATORY)

## Precision
- Use exact decimal arithmetic for money calculations
- Document rounding rules explicitly
- NEVER use floating point equality (price === target)
- Use: Math.abs(price - target) < 0.01

## State Management
- Positions and balances are IMMUTABLE
- WRONG: position.size += newSize
- CORRECT: { ...position, size: position.size + newSize }
- All state changes must be logged with timestamps

## Error Handling
- Network errors → retry with exponential backoff (max 3 attempts)
- Invalid data → log and skip, never crash
- Oracle disagreement → log divergence, use primary source

## Validation Before Use
- Prices must be > 0
- Timestamps must be in valid range
- Volatility must be 0 < σ < 5 (annualized)
- Check position limits before any order

---