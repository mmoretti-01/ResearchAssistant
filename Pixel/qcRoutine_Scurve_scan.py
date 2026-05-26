import time
from pathlib import Path
import json
from routines.qcRoutine_injection import Injection
from scripts.Scurve_plot import make_Scurve_plot

# -----------------------------------------------------------------------------
# S-curve parameter scan
# -----------------------------------------------------------------------------
# Sweeps over threshold and calibration-voltage settings, performs one
# injection measurement for each parameter pair and determines the settings
# that produce the best per-chip quality score.
class Scurve_scan(object):
    # -------------------------------------------------------------------------
    # Scan initialization
    # -------------------------------------------------------------------------
    # Stores the control interfaces, resolves the parameter-scan range and
    # prepares the output paths used during optimization.
    #
    # full_qc controls where scan parameters are read from:
    #   True  -> use the values supplied by QC_Grading
    #   False -> request values through the sequencer parameter interface

    def __init__(self, seq, mapping, chip_handler, power, full_qc=False, QC_Grading=None, ThHigh=None, ThLow=None, VCAL=None):
        self.seq = seq
        self.c = chip_handler
        self.m = mapping
        self.p = power
        self.full_qc = full_qc
        self.qc_grading = QC_Grading

        # Stores optional externally supplied threshold and VCAL settings.
        self.th_high_dynamic = ThHigh
        self.th_low_dynamic = ThLow
        self.vcal_dynamic = VCAL

        # Directory containing injection scan output and optimized parameters.
        self.output_dir = Path("/home/mu3e/online/online/userfiles/sequencer/pixels/python_qc") / "output"

        # ---------------------------------------------------------------------
        # Enabled chip and channel selection
        # ---------------------------------------------------------------------
        # Restricts the scan to chips selected by the ASIC mask and activates
        # only the relevant detector side for the requested stream.
        self.chip_list = [int(x) for x in self.m.get_chip_list_from_asic_mask()]
        self.stream = self.m.stream

        if self.m.dut == "chip":
            self.seq.odb_set(f"{self.m.odb_user_mask}[0]", True)
            self.seq.odb_set(f"{self.m.odb_user_mask}[{self.m.DS}]", False)
        else:
            if self.stream == "US":
                self.seq.odb_set(f"{self.m.odb_user_mask}[{self.m.US}]", True)
                self.seq.odb_set(f"{self.m.odb_user_mask}[{self.m.DS}]", False)
            elif self.stream == "DS":
                self.seq.odb_set(f"{self.m.odb_user_mask}[{self.m.DS}]", True)
                self.seq.odb_set(f"{self.m.odb_user_mask}[{self.m.US}]", False)
            elif self.stream == "both_sided":
                self.seq.odb_set(f"{self.m.odb_user_mask}[{self.m.US}]", True)
                self.seq.odb_set(f"{self.m.odb_user_mask}[{self.m.DS}]", True)

        # Reads back the enabled partitions after setting the side mask.
        n_parts = self.seq.odb_get(self.m.odb_user_mask)
        self.enabled_channels = [i for i, enabled in enumerate(n_parts) if enabled]

        # ---------------------------------------------------------------------
        # Scan parameter source
        # ---------------------------------------------------------------------
        # Uses the full-QC grading object when running in full-QC mode;
        # otherwise reads each value from the sequencer parameter store.
        source = self.qc_grading if self.full_qc else self.seq.get_param

        self.max_columns      = getattr(source, "MaxColumns") if self.full_qc else source("MaxColumns")
        self.min_columns      = getattr(source, "MinColumns") if self.full_qc else source("MinColumns")
        self.max_rows         = getattr(source, "MaxRows") if self.full_qc else source("MaxRows")
        self.min_rows         = getattr(source, "MinRows") if self.full_qc else source("MinRows")
        self.pulse_number     = getattr(source, "PulseNumber") if self.full_qc else source("PulseNumber")
        self.wait             = getattr(source, "injectionWaitTime") if self.full_qc else source("injectionWaitTime")
        self.inj_puls         = getattr(source, "Injection_pulse") if self.full_qc else source("Injection_pulse")
        self.th_high          = getattr(source, "ThHigh") if self.full_qc else source("ThHigh")
        self.th_low           = getattr(source, "ThLow") if self.full_qc else source("ThLow")
        self.vcal             = getattr(source, "VCAL") if self.full_qc else source("VCAL")
        self.runstart_working = getattr(source, "runstart_working") if self.full_qc else source("runstart_working")
        self.hv_voltage       = seq.get_param("hv_voltage")
        self.hv_current_limit = seq.get_param("hv_current_limit")
        self.lv_voltage       = seq.get_param("lv_voltage")

        # Defines the parameter range traversed by the S-curve optimization.
        self.th_high_max      = getattr(source, "ThHigh_max") if self.full_qc else source("ThHigh_max")
        self.th_high_low      = getattr(source, "ThHigh_min") if self.full_qc else source("ThHigh_min")
        self.VCAL_max         = getattr(source, "VCAL_max") if self.full_qc else source("VCAL_max")
        self.VCAL_low         = getattr(source, "VCAL_min") if self.full_qc else source("VCAL_min")
        self.th_high_step     = getattr(source, "ThHigh_step") if self.full_qc else source("ThHigh_step")
        self.VCAL_step        = getattr(source, "VCAL_step") if self.full_qc else source("VCAL_step")

        # ---------------------------------------------------------------------
        # Power configuration
        # ---------------------------------------------------------------------
        # Applies the configured high voltage to all enabled channels.
        # Standalone scans additionally configure and validate low voltage and
        # the high-voltage current limit.
        self.p.hv_set(self.enabled_channels, [self.hv_voltage] * len(self.enabled_channels))
        if not self.full_qc:
            self.p.lv_set(self.enabled_channels, [self.lv_voltage] * len(self.enabled_channels))
            self.p.lv_check_on(self.enabled_channels)
            self.p.hv_set_current_limit(self.enabled_channels, [self.hv_current_limit] * len(self.enabled_channels))
            self.p.hv_check_on(self.enabled_channels)

        # ---------------------------------------------------------------------
        # Output file configuration
        # ---------------------------------------------------------------------
        # Builds DUT-specific output names for the injection records collected
        # during the scan and for the full-QC result file. (Hardcoded parents)
        BASE_DIR = Path(__file__).resolve().parents[2] / "python_qc" / "output"
        if self.m.dut == "chip":
            fname = f"injection_{self.m.partID}.ndjson"
            self.full_qc_path = BASE_DIR / f"full_QC_{self.m.partID}.json"
        else:
            fname = f"injection_{self.m.partID}_{self.stream}.ndjson"
            self.full_qc_path = BASE_DIR / f"full_QC_{self.m.partID}_{self.stream}.json"

        self.ndjson_path = self.m.build_output_path(filename=fname, directory=BASE_DIR, from_scratch=self.m.from_scratch, overwrite_last=self.m.overwrite_last,)

        # Loads an existing full-QC record only when the scan is running as
        # part of a full-QC sequence.
        if self.full_qc_path.exists() and self.full_qc:
            with open(self.full_qc_path, "r") as f:
                self.full_qc_file = json.load(f)
        else:
            self.full_qc_file = {}
        return


    # -------------------------------------------------------------------------
    # Parameter-quality score
    # -------------------------------------------------------------------------
    # Computes the score used to compare candidate parameter settings for each
    # chip from its inactive-pixel and noisy-pixel ratios.
    #
    # The currently configured coefficients produce:
    #   score = inactive - noisy
    #
    # A lower score is considered better by the optimization loop.
    def weighted_function(self, inactive, noisy):
        p0 = [1, 1, -1, 1]
        res = 0
        res = p0[0]*inactive**p0[1] + p0[2]*noisy**p0[3]
        return res


    # -------------------------------------------------------------------------
    # Optimal-parameter output
    # -------------------------------------------------------------------------
    # Writes one JSON file containing the best parameter combination selected
    # for each analyzed chip position.
    def store_output_data(self, results):
        if self.m.dut == "chip":
            output_file = self.output_dir / f"injection_optimal_{self.m.partID}.json"
        else:
            output_file = self.output_dir / f"injection_optimal_{self.m.partID}_{self.m.stream}.json"

        output_data = {"partID": self.m.partID, "chips": results}
        with open(output_file, "w") as f:
            json.dump(output_data, f, indent=2)

        self.seq.msg(f"Per-chip optimal injection parameters written to {output_file}")
        return


    # -------------------------------------------------------------------------
    # S-curve scan execution
    # -------------------------------------------------------------------------
    # Iterates through the requested ThHigh and VCAL parameter grid, performs
    # an injection measurement for each pair and retains the best result for
    # every chip position.
    def Scan(self):
        # ---------------------------------------------------------------------
        # Injection-result input path
        # ---------------------------------------------------------------------
        # Resolves the NDJSON file expected to contain the individual
        # Injection records produced during this parameter scan.
        if self.m.dut == "chip":
            json_path = self.output_dir / f"injection_{self.m.partID}.ndjson"

        else:
            json_path = self.output_dir / f"injection_{self.m.partID}_{self.m.stream}.ndjson"

        best_per_chip = {}
        run_number_initial = int(self.seq.odb_get("/Runinfo/Run number")) + 1

        # ---------------------------------------------------------------------
        # Threshold and VCAL parameter grid
        # ---------------------------------------------------------------------
        # Evaluates every combination of:
        #   ThHigh -> from ThHigh_min to ThHigh_max in ThHigh_step increments
        #   VCAL   -> from VCAL_min to VCAL_max in VCAL_step increments
        #
        # ThLow is always set one unit below the current ThHigh value.
        for th_high in range(self.th_high_low, self.th_high_max + 1, self.th_high_step):
            self.th_high = th_high
            self.th_low = th_high - 1

            for vcal in range(self.VCAL_low, self.VCAL_max + 1, self.VCAL_step):
                self.vcal = vcal

                # -------------------------------------------------------------
                # Injection measurement for one parameter pair
                # -------------------------------------------------------------
                # Runs a complete injection scan using the current threshold
                # and calibration-voltage combination.
                injection = Injection(
                    self.seq,
                    self.m,
                    self.c,
                    self.p,
                    full_qc=False,
                    QC_Grading=self.qc_grading,
                    ThHigh = th_high,
                    ThLow = th_high - 1,
                    VCAL = vcal
                )

                # -------------------------------------------------------------
                # Direct retrieval of the produced injection record
                # -------------------------------------------------------------
                # Injection.start() returns the file offset at which its NDJSON
                # result was appended. Seeking to that offset avoids scanning
                # all previously written parameter points.
                offset = injection.start()
                start_time = time.time()

                with open(json_path, "r") as f:
                    f.seek(offset)

                    # Waits until a valid JSON record is available at the
                    # returned output-file position.
                    while True:
                        line = f.readline()
                        if line:
                            try:
                                record = json.loads(line)
                                break
                            except json.JSONDecodeError:
                                continue

                        if time.time() - start_time > 10:
                            raise TimeoutError("Injection result timeout")

                        time.sleep(0.5)

                # -------------------------------------------------------------
                # Per-chip candidate evaluation
                # -------------------------------------------------------------
                # Calculates the inactive and noisy fractions for this
                # parameter pair and updates each chip only when the new score
                # is better than its previously stored candidate.
                for chip in record["chips"]:
                    pos = chip["position"]

                    if pos not in best_per_chip:
                        best_per_chip[pos] = {
                            "score": float("inf"),
                            "vcal_opt": None,
                            "th_high_opt": None,
                            "th_low_opt": None,
                            "inactive_ratio": None,
                            "noisy_ratio": None,
                        }

                    total_pixel = chip["total_pixels"]
                    if total_pixel == 0:
                        self.seq.msg(f"No Pixel covered!")
                        total_pixel = 1

                    inactive_ratio = chip["inactive_pixel"] / total_pixel
                    noisy_ratio = chip["noisy_pixel"] / total_pixel

                    score = self.weighted_function(inactive_ratio, noisy_ratio)

                    if score < best_per_chip[pos]["score"]:
                        best_per_chip[pos].update({
                            "score": score,
                            "vcal_opt": vcal,
                            "th_high_opt": th_high,
                            "th_low_opt": th_high - 1,
                            "inactive_ratio": inactive_ratio,
                            "noisy_ratio": noisy_ratio,
                        })

        # ---------------------------------------------------------------------
        # Scan summary output
        # ---------------------------------------------------------------------
        # Captures the final run number, creates the S-curve plot across the
        # completed run range and writes the selected per-chip parameters.
        run_number_end = int(self.seq.odb_get("/Runinfo/Run number"))
        make_Scurve_plot(run_number_initial, run_number_end, self.m)
        self.store_output_data(best_per_chip)
        return


    def start(self):
        self.seq.msg("Starting Scurve scan..")
        self.Scan()
        return
