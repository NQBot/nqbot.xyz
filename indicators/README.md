# PhillyFranksTools Indicators for NinjaTrader 8

A collection of utility indicators for NinjaTrader 8 focused on time/session awareness and market analysis.

## Indicators Included

### Strategies

#### Trend Pullback B  (TrendPullbackB.zip)
Trend + pullback to EMA/VWAP on NQ, shipped as a strategy **and** a manual signal
indicator so it can be traded by hand where automation is not allowed.

**Contents:**
- `Strategies/TrendPullbackB.cs` - orders, account guard, clock rules
- `Indicators/TrendPullbackSignal.cs` - the signal engine and manual display, no orders
- `README.md`, `CLAUDE.md`, `AGENTS.md`, `LICENSE`

**Notes:**
- The strategy calls the indicator for its signals, so the two cannot diverge
- 1-minute NQ/MNQ, ETH template, NinjaTrader set to US Eastern
- Both files must be installed; the strategy will not compile without the indicator
- Arena record: 20 simulated $50K evaluation attempts, 9 passed, 11 failed (45%),
  8 Jul - 17 Sep 2026. Simulated, unaudited, and not a promise of anything.

---

#### Donchian Breakout  (DonchianBreakoutUS.zip)
N-bar channel breakout taken only with the 5-minute trend. Ships as a strategy **and**
a manual signal indicator.

**Contents:**
- `Strategies/DonchianBreakoutUS.cs` - orders, account guard, clock rules
- `Indicators/DonchianBreakoutFollow.cs` - the signal engine and manual display, no orders
- `README.md`, `CLAUDE.md`, `AGENTS.md`, `LICENSE`

**Notes:**
- Adds a 5-minute data series for the trend gate, which fails closed without history
- A stop-out disarms that direction until price trades back through the channel midpoint,
  so the signal depends on the outcome of the previous trade
- Arena record: 24 simulated $50K evaluation attempts, 9 passed, 15 failed (37.5%),
  6 Jul - 18 Sep 2026. Simulated and unaudited.

---

#### VWAP Reclaim  (VwapReclaimAN.zip)
Break of the session VWAP then a reclaim of it, traded in the reclaim direction.
Ships as a strategy **and** a manual signal indicator.

**Contents:**
- `Strategies/VWAPReclaimAN.cs` - orders, account guard, clock rules
- `Indicators/VwapReclaimFollow.cs` - the signal engine and manual display, no orders
- `README.md`, `CLAUDE.md`, `AGENTS.md`, `LICENSE`

**Notes:**
- Two presets: Asian with no ATR filter, US with the 15-30 ATR band
- The VWAP is window-anchored and resets on the first bar of the session, so it will
  not match a standard VWAP indicator. That is deliberate.
- Arena record: 13 simulated $50K evaluation attempts on the Asian preset, 6 passed,
  7 failed (46.2%), 23 Jul - 17 Sep 2026. Simulated, unaudited, small sample.

---

### Session & Time Tools

#### WorldClock
Advanced world trading sessions indicator displaying live market status for 20+ global exchanges.

**Features:**
- Real-time market open/closed status with countdown timers
- Holiday calendar engine (2026-2030) for NYSE, CME, LSE, JPX, and more
- CME Globex special handling (maintenance windows, evening reopens)
- Early close detection and alerts
- Customizable display (colors, fonts, position)
- Built-in test harness for calendar validation

#### FloatingLocalClock
Draggable floating clock overlay showing multiple time zones.

**Features:**
- Display local time and up to 3 additional time zones
- Draggable positioning on chart
- Customizable colors and font

#### LocalClock
Fixed-position clock displaying current time with multiple time zones.

#### FloatingBarTimer
Shows countdown timer for current bar completion.

**Features:**
- Supports Tick, Minute, and Second chart types
- Floats near the current bar
- Customizable font and position

#### AsianEuropeanSessionHighLow
Draws session high/low boxes for Asian and European trading sessions.

**Features:**
- Configurable session times
- Visual session range boxes
- Customizable colors

---

### Analysis Tools

#### BollingerBandWidth
Displays Bollinger Band width with squeeze detection.

**Features:**
- Band width calculation (upper - lower band)
- Squeeze detection (low volatility)
- Expansion/contraction coloring
- Keltner Channel squeeze method

#### PFHistoricalDownloader
Downloads historical bar data to CSV files.

**Features:**
- Export minute or tick data
- Configurable date ranges
- Automatic chunking for large requests
- Progress feedback

---

## Installation

Before importing a ZIP, verify its SHA-256 digest against the repository's
[`SHA256SUMS`](../SHA256SUMS) manifest.

1. Copy all `.cs` files to:
   ```
   Documents\NinjaTrader 8\bin\Custom\Indicators\
   ```

2. Restart NinjaTrader 8, or compile manually:
   - **Tools → New NinjaScript → Compile**

3. Add indicators to charts via:
   - Right-click chart → **Indicators** → Look under **PhillyFranksTools** folder

---

## Indicator Details

### WorldClock

| Setting | Description |
|---------|-------------|
| Show [City] | Toggle display for each trading center |
| Show Trading Hours | Display CME futures session times |
| Show Holiday Checker | Show upcoming holidays/early closes |
| Font Size | Text size (8-48) |
| Colors | Customize Live, Closed, Alert, Opening Soon colors |
| Position | Horizontal/Vertical offset from corner |

**Supported Markets:**
- Americas: NYSE, CME Globex, Toronto, Sao Paulo
- Europe: London, Frankfurt, Paris, Zurich, Moscow
- Middle East: Dubai, Riyadh
- Asia: Tokyo, Hong Kong, Shanghai, Singapore, Mumbai
- Pacific: Sydney, Wellington

### BollingerBandWidth

| Setting | Description |
|---------|-------------|
| Period | Bollinger Band period (default: 20) |
| StdDev | Standard deviation multiplier (default: 2) |
| Squeeze Threshold | Width level indicating squeeze |
| Show Squeeze Dots | Visual squeeze indicator |

### FloatingBarTimer

| Setting | Description |
|---------|-------------|
| Text Font | Font family, size, style |
| Text Color | Timer text color |
| MarginToRight | Distance from bar to timer |
| HeightMargin | Vertical offset from bar center |

### PFHistoricalDownloader

| Setting | Description |
|---------|-------------|
| Instrument | Symbol to download |
| Start/End Date | Date range for data |
| Output Path | Folder for CSV files |
| Data Type | Minute or Tick data |

---

## Screenshots

*Add screenshots of each indicator here*

---

## Requirements

- NinjaTrader 8
- Windows (indicators use WPF rendering)
- Market data subscription (for live features)

---

## Notes

### WorldClock Calendar Updates
The WorldClock indicator includes embedded holiday data for 2026-2030. To update for future years:

1. Open `WorldClock.cs`
2. Find the `InitializeHolidayData()` method
3. Add new year's holidays following the existing pattern
4. Update `DATA_END_DATE` constant
5. Recompile

### Testing WorldClock
To run the built-in test harness:
1. Set `EnableDebugOutput = true` in the code
2. Set `RunTestsOnStartup = true` in the code
3. Add indicator to chart
4. Check Output window (Ctrl+O) for results

---

## License

MIT License - See LICENSE file

---

## Author

PhillyFrank

---

## Contributing

Issues and pull requests welcome!
