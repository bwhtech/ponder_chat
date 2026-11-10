# Makes the chart that the demo's Python reply shows (scripts/demo/seed.ts).
# Run: uv run --with matplotlib --with pandas python scripts/demo/assets/make_chart.py
import os
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

here = os.path.dirname(os.path.abspath(__file__))
df = pd.read_csv(os.path.join(here, "cafe-sales.csv"))
order = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
by_day = df.groupby("weekday")[["pastries", "coffees"]].mean().reindex(order)

fig, ax = plt.subplots(figsize=(8, 4.2), dpi=150)
colors = ["#c7d2fe" if day not in ("Sat", "Sun") else "#4f46e5" for day in order]
bars = ax.bar(order, by_day["pastries"], color=colors, width=0.62)
ax.bar_label(bars, fmt="%.0f", padding=3, fontsize=9, color="#374151")
ax.set_title("Average pastries sold per day, Aug–Oct", loc="left", fontsize=12, color="#111827", pad=12)
ax.set_ylabel("Pastries")
for side in ("top", "right", "left"):
    ax.spines[side].set_visible(False)
ax.tick_params(axis="y", length=0, colors="#6b7280")
ax.tick_params(axis="x", colors="#374151")
ax.grid(axis="y", color="#e5e7eb", linewidth=0.8)
ax.set_axisbelow(True)
fig.tight_layout()
fig.savefig(os.path.join(here, "pastries-by-weekday.png"))
