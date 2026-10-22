# Duration API: reject negative values

- `/duration?ms=<number>` returns status 400 for every negative duration.
- Non-negative finite durations keep the existing status 200 and text.
- NaN and infinities return status 400.
