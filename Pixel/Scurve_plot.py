import json
from collections import defaultdict
import numpy as np
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# -----------------------------------------------------------------------------
# S-curve result plotting
# -----------------------------------------------------------------------------
# Reads the injection results produced during an S-curve scan, derives
# efficiency and hit-count quantities for each chip and creates 3D-surface
# and two-dimensional heatmap plots across the ThHigh/VCAL parameter grid.

def make_Scurve_plot(run_start, run_end, mapping):
    records = []

    SCRIPT_DIR = Path(__file__).resolve().parent

    # -------------------------------------------------------------------------
    # Output directory configuration
    # -------------------------------------------------------------------------
    # Resolves the plot output directory relative to this script and creates
    # the optimum-plots folder when it does not already exist.
    OUTPUT_DIR = SCRIPT_DIR.parent / "output" / "optimum_plots"
    OUTPUT_DIR.mkdir(exist_ok=True)

    # -------------------------------------------------------------------------
    # Injection-result input file
    # -------------------------------------------------------------------------
    # Selects the NDJSON file associated with the tested DUT:
    #   chip test     -> use the part-specific injection output file
    #   streamed test -> include the active stream in the filename
    if mapping.dut == "chip":
        json_path = OUTPUT_DIR.parent / f"injection_{mapping.partID}.ndjson"

    else:
        json_path = OUTPUT_DIR.parent / f"injection_{mapping.partID}_{mapping.stream}.ndjson"


    # -------------------------------------------------------------------------
    # NDJSON result loading
    # -------------------------------------------------------------------------
    # Reads one injection record per line and retains only measurements whose
    # run number belongs to the S-curve scan range requested for plotting.
    with open(json_path) as f:   # one JSON per line
        for line in f:
            entry = json.loads(line)

            run = entry["env"]["run_number"]
            if not (run_start <= run <= run_end):
                continue

            # Flattens the per-run chip records into one list so each chip can
            # later be grouped across all tested threshold/VCAL combinations.
            for chip in entry["chips"]:
                records.append({
                    "run": run,
                    "chip": chip["position"],
                    "ThHigh": chip["ThHigh"],
                    "VCAL": chip["VCAL"],
                    "active_pixel": chip["active_pixel"],
                    "InTime": chip["InTime"],
                    "OutOfTime": chip["OutOfTime"],
                    "SCCN": chip["SCCN"],
                    "SorterOut": chip["SorterOut"],
                    "counts": chip["counts"],
                    "Overflow": chip["OVERFLOW"],
                    "TotalPixel": chip["total_pixels"],
                    "n_pulses": chip["n_pulses"]
                })

    # -------------------------------------------------------------------------
    # Expected hit-count normalization
    # -------------------------------------------------------------------------
    # Uses the number of scanned pixels and injected pulses from the selected
    # data to compute the expected number of pixel hits for one measurement.
    total_pixel = records[0]["TotalPixel"]
    n_pulses    = records[0]["n_pulses"]

    expected_counts = total_pixel*n_pulses

    # -------------------------------------------------------------------------
    # Run-level hit aggregation
    # -------------------------------------------------------------------------
    # Accumulates the selected readout-counter values across all chips for each
    # run so run-wide quantities can be attached to every chip record.
    intime_sum = defaultdict(float)
    outoftime_sum = defaultdict(float)
    overflow_sum = defaultdict(float)

    for r in records:
        run = r["run"]
        intime_sum[run]     += r["InTime"]
        outoftime_sum[run]  += r["OutOfTime"]
        overflow_sum[run]   += r["Overflow"]

    # -------------------------------------------------------------------------
    # Derived efficiency and hit-count quantities
    # -------------------------------------------------------------------------
    # Extends every chip record with run-level sums and quantities used as
    # surfaces in the final plots.
    for r in records:
        run = r["run"]

        r["InTime_sum"]     = intime_sum[run]
        r["OutOfTime_sum"]  = outoftime_sum[run]
        r["Overflow_sum"]   = overflow_sum[run]

        # Derived quantities

        denom = r["InTime"] + r["OutOfTime"] + r["Overflow"]

        r["SORTER Efficiency"] = (r["InTime"] / denom if denom != 0 else 0.0)

        r["Pixel Efficiency"] = ( denom / expected_counts )

        total_denom = (r["InTime_sum"] + r["OutOfTime_sum"] + r["Overflow_sum"])

        #r["Total SORTER Efficiency"] = (r["SorterOut"] / total_denom if total_denom != 0 else 0.0)
        r["Total Hits"] = (denom)

        r["Counts Ratio"] = ((r["counts"]) / denom if denom != 0 else 0.0)


    # -------------------------------------------------------------------------
    # ThHigh x VCAL grid construction
    # -------------------------------------------------------------------------
    # Builds one two-dimensional parameter grid per chip for every quantity
    # that will be visualized.
    grids = {}

    chips = sorted({r["chip"] for r in records})
    grids = {}

    for chip in chips:
        sub = [r for r in records if r["chip"] == chip]

        Th_vals   = sorted({r["ThHigh"] for r in sub})
        VCAL_vals = sorted({r["VCAL"] for r in sub})

        ap_matrix              = np.zeros((len(Th_vals), len(VCAL_vals)))
        fifos_matrix           = np.zeros_like(ap_matrix)
        sorter_matrix          = np.zeros_like(ap_matrix)
        total_sorter_matrix    = np.zeros_like(ap_matrix)
        combined_matrix        = np.zeros_like(ap_matrix)

        th_index   = {v: i for i, v in enumerate(Th_vals)}
        vcal_index = {v: j for j, v in enumerate(VCAL_vals)}

        for r in sub:
            i = th_index[r["ThHigh"]]
            j = vcal_index[r["VCAL"]]

            ap_matrix[i, j]           = r["counts"]
            fifos_matrix[i, j]         = r["Pixel Efficiency"]
            sorter_matrix[i, j]       = r["SORTER Efficiency"]
            total_sorter_matrix[i, j] = r["Total Hits"]
            combined_matrix[i, j]     = r["Counts Ratio"]

        grids[chip] = {
            "ThHigh": Th_vals,
            "VCAL": VCAL_vals,
            "Counts": ap_matrix,
            "Pixel Efficiency": fifos_matrix,
            "SORTER Efficiency": sorter_matrix,
            "Total Hits": total_sorter_matrix,
            "Counts Ratio": combined_matrix,
        }

    # -------------------------------------------------------------------------
    # Plot generation
    # -------------------------------------------------------------------------
    # Creates both a 3D surface plot and a two-dimensional heatmap for each
    # measured quantity of each chip.
    for chip in chips:
        data = grids[chip]

        Th, VC = np.meshgrid(data["ThHigh"], data["VCAL"], indexing="ij")

        plots = [
            ("Counts", "Counts", "viridis"),
            ("Pixel Efficiency", "Pixel Efficiency", "cividis"),
            ("SORTER Efficiency", "SORTER Efficiency", "cividis"),
            ("Total Hits", "Total Hits", "viridis"),
            ("Counts Ratio", "Count Ratio", "cividis"),
        ]

        for key, zlabel, cmap in plots:
            Z = data[key]

            # -----------------------------------------------------------------
            # 3D surface plot
            # -----------------------------------------------------------------
            # Visualizes the selected quantity as a surface across the scanned
            # ThHigh and VCAL parameter coordinates.
            fig = plt.figure(figsize=(8, 7), dpi=150)
            ax = fig.add_subplot(111, projection="3d")

            ax.plot_surface(Th, VC, Z, cmap=cmap)
            ax.set_xlabel("ThHigh")
            ax.set_ylabel("VCAL")
            ax.set_zlabel(zlabel)
            ax.set_title(f"{zlabel} vs ThHigh & VCAL ({chip})")
            ax.view_init(elev=30, azim=170)

            plt.tight_layout()

            outdir = OUTPUT_DIR / "3D" / f"runs_{run_start}_{run_end}" / f"chipNr{chip}"
            outdir.mkdir(parents=True, exist_ok=True)

            # Define the output file path
            outfile = outdir / f"{key.replace(' ', '_')}_3D.png"

            # Save the figure
            plt.savefig(outfile, bbox_inches="tight")
            plt.show()

            # -----------------------------------------------------------------
            # Two-dimensional heatmap
            # -----------------------------------------------------------------
            # Visualizes the same parameter grid as a color-coded matrix with
            # VCAL on the x-axis and ThHigh on the y-axis.
            fig, ax = plt.subplots(figsize=(7, 6), dpi=150)

            im = ax.imshow(
                Z,
                cmap=cmap,
                origin="lower",
                aspect="auto",
                extent=[
                    min(data["VCAL"]),
                    max(data["VCAL"]),
                    min(data["ThHigh"]),
                    max(data["ThHigh"]),
                ],
            )

            ax.set_xlabel("VCAL")
            ax.set_ylabel("ThHigh")
            ax.set_title(f"{zlabel} ({chip})")

            cbar = plt.colorbar(im, ax=ax)
            cbar.set_label(zlabel)

            plt.tight_layout()

            outdir = OUTPUT_DIR / "imshow" / f"runs_{run_start}_{run_end}" / f"chipNr{chip}"
            outdir.mkdir(parents=True, exist_ok=True)

            # Define the output file path
            outfile = outdir / f"{key.replace(' ', '_')}_imshow.png"

            # Save the figure
            plt.savefig(outfile, bbox_inches="tight")
            plt.show()
