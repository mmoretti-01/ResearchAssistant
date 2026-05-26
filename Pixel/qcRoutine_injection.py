# --- PRELOAD BEFORE ANYTHING THAT MIGHT IMPORT ROOT ---
import threading
import six
import dateutil
import dateutil.tz
import dateutil.parser
import time
from pathlib import Path
import json
import shutil

# -----------------------------------------------------------------------------
# Injection scan
# -----------------------------------------------------------------------------
# Configures chip thresholds, performs a full-chip injection scan and stores
# per-chip hitmap statistics together with readout and power diagnostics.
class Injection(object):
    # -------------------------------------------------------------------------
    # Scan initialization
    # -------------------------------------------------------------------------
    # Stores the control interfaces, resolves the scan configuration and
    # prepares the output files used for the injection results.
    #
    # full_qc controls where scan parameters are read from:
    #   True  -> use the values supplied by QC_Grading
    #   False -> request values through the sequencer parameter interface

    def __init__(
        self,
        seq,
        mapping,
        chip_handler,
        power,
        full_qc=False,
        QC_Grading=None,
        ThHigh=None,
        ThLow=None,
        VCAL=None,
        tdac=None,
        ndjson_path=None,
    ):
        self.ndjson_path = ndjson_path
        self.seq = seq
        self.c = chip_handler
        self.m = mapping
        self.p = power
        self.full_qc = full_qc
        self.qc_grading = QC_Grading

        # Stores optional threshold values supplied for dynamic injection scans.
        self.th_high_dynamic = ThHigh
        self.th_low_dynamic = ThLow
        self.vcal_dynamic = VCAL
        self.tdac_dynamic = tdac

        # ---------------------------------------------------------------------
        # ROOT initialization state
        # ---------------------------------------------------------------------
        # ROOT is loaded only when the injection analysis starts, avoiding
        # unnecessary interpreter setup during object construction.
        self._root_ready = False
        self.ROOT = None

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

        self.max_columns = getattr(source, "MaxColumns") if self.full_qc else source("MaxColumns")
        self.min_columns = getattr(source, "MinColumns") if self.full_qc else source("MinColumns")
        self.max_rows = getattr(source, "MaxRows") if self.full_qc else source("MaxRows")
        self.min_rows = getattr(source, "MinRows") if self.full_qc else source("MinRows")
        self.pulse_number = getattr(source, "PulseNumber") if self.full_qc else source("PulseNumber")
        self.wait = getattr(source, "injectionWaitTime") if self.full_qc else source("injectionWaitTime")
        self.inj_puls = getattr(source, "Injection_pulse") if self.full_qc else source("Injection_pulse")
        self.hv_voltage = seq.get_param("hv_voltage")
        self.hv_current_limit = seq.get_param("hv_current_limit")
        self.lv_voltage = seq.get_param("lv_voltage")
        self.th_high = getattr(source, "ThHigh") if self.full_qc else source("ThHigh")
        self.th_low = getattr(source, "ThLow") if self.full_qc else source("ThLow")
        self.vcal = getattr(source, "VCAL") if self.full_qc else source("VCAL")
        self.runstart_working = getattr(source, "runstart_working") if self.full_qc else source("runstart_working")

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
        # Builds DUT-specific output names so chip tests and streamed tests
        # write independent NDJSON records and full-QC references.
        BASE_DIR = Path(__file__).resolve().parents[2] / "python_qc" / "output"
        BASE_DIR.mkdir(parents=True, exist_ok=True)

        if self.m.dut == "chip":
            default_fname = f"injection_{self.m.partID}.ndjson"
            self.full_qc_path = BASE_DIR / f"full_QC_{self.m.partID}.json"
        else:
            default_fname = f"injection_{self.m.partID}_{self.stream}.ndjson"
            self.full_qc_path = BASE_DIR / f"full_QC_{self.m.partID}_{self.stream}.json"

        # Uses a provided output path when available; otherwise creates the
        # default path according to the scan overwrite configuration.
        if self.ndjson_path is None:
            self.ndjson_path = self.m.build_output_path(
                filename=default_fname,
                directory=BASE_DIR,
                from_scratch=self.m.from_scratch,
                overwrite_last=self.m.overwrite_last,
            )
        else:
            self.ndjson_path = self.ndjson_path

        self.ndjson_path = Path(self.ndjson_path)
        self.ndjson_path.parent.mkdir(parents=True, exist_ok=True)
        self.ndjson_path.touch(exist_ok=True)

        self.seq.msg(f"[Injection] ndjson_path = {self.ndjson_path}")

        # Loads an existing full-QC record only when the scan is running as
        # part of a full-QC sequence.
        if self.full_qc_path.exists() and self.full_qc:
            with open(self.full_qc_path, "r") as f:
                self.full_qc_file = json.load(f)
        else:
            self.full_qc_file = {}

    # -------------------------------------------------------------------------
    # ROOT hitmap extraction helper
    # -------------------------------------------------------------------------
    # Loads ROOT only when analysis is required and declares the C++ helper
    # once. The helper reads one hitmap and returns:
    #   element 0 -> number of scanned pixels
    #   element 1 -> number of inactive pixels
    #   element 2 -> number of noisy pixels
    #   element 3 -> accumulated hit count
    def _ensure_root(self):
        if self._root_ready:
            return
        import ROOT
        self.ROOT = ROOT

        if not hasattr(self.ROOT, "get_injection_stats"):
            self.ROOT.gInterpreter.Declare(
                r"""
                #include "TFile.h"
                #include "TH2.h"
                #include <vector>
                #include <algorithm>

                std::vector<int> get_injection_stats(const char* filename,
                                                     const char* histname,
                                                     double threshold,
                                                     double noise_threshold,
                                                     int min_col,
                                                     int max_col,
                                                     int min_row,
                                                     int max_row)
                {
                    std::vector<int> out(5);
                    out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0;

                    TFile f(filename, "READ");
                    if (f.IsZombie()) return out;

                    TH2* h = dynamic_cast<TH2*>(f.Get(histname));
                    if (!h) return out;

                    int nx = h->GetNbinsX();
                    int ny = h->GetNbinsY();

                    int ix_min = std::max(1, min_col + 1);

                    int ix_max;
                    if (max_col % 2 != 0) ix_max = std::min(nx, max_col + 1);
                    else                  ix_max = std::min(nx, max_col + 2);

                    int iy_min = std::max(1, min_row + 1);
                    int iy_max = std::min(ny, max_row + 1);

                    int total = 0, inactive = 0, noisy = 0;
                    double counts = 0;

                    for (int ix = ix_min; ix <= ix_max; ++ix) {
                        for (int iy = iy_min; iy <= iy_max; ++iy) {
                            double c = h->GetBinContent(ix, iy);
                            counts += c;
                            ++total;
                            if (c < threshold) ++inactive;
                            else if (c > noise_threshold) ++noisy;
                        }
                    }

                    out[0] = total;
                    out[1] = inactive;
                    out[2] = noisy;
                    out[3] = (int)counts;
                    return out;
                }
                """
            )

        self._root_ready = True

    # -------------------------------------------------------------------------
    # Threshold and calibration configuration
    # -------------------------------------------------------------------------
    # Applies either the configured default DAC values or dynamically supplied
    # values to each selected chip before starting the injection scan.
    #
    # th_high_dynamic controls which settings are applied:
    #   None      -> use the default scan configuration values
    #   otherwise -> use the dynamically supplied threshold and VCAL values
    def set_thresholds(self):
        chip_set = set(self.chip_list)
        dyn = 0

        for asic in range(self.m.N_chips):
            for pp in self.enabled_channels:
                cfg_id = asic + self.m.feb_link[pp]
                if cfg_id not in chip_set:
                    continue

                if self.th_high_dynamic is None:
                    self.c.set_chip_dac(cfg_id, "ThHigh", int(self.th_high))
                    self.c.set_chip_dac(cfg_id, "ThLow", int(self.th_low))
                    self.c.set_chip_dac(cfg_id, "VCAL", int(self.vcal))
                    dyn = 0
                else:
                    self.c.set_chip_dac(cfg_id, "ThHigh", int(self.th_high_dynamic))
                    self.c.set_chip_dac(cfg_id, "ThLow", int(self.th_low_dynamic))
                    self.c.set_chip_dac(cfg_id, "VCAL", int(self.vcal_dynamic))
                    dyn = 1

        # Pushes the DAC configuration to the hardware and resets the PLLs
        # after all selected chips have been updated.
        self.c.configure_chip(999)
        self.c.Reset_PLL_all(self.chip_list)

        if dyn == 0:
            self.seq.msg(f"Applied thresholds: ThHigh={self.th_high}, ThLow={self.th_low}, VCAL={self.vcal}")
        else:
            self.seq.msg(
                f"Applied thresholds: ThHigh={self.th_high_dynamic}, ThLow={self.th_low_dynamic}, "
                f"VCAL={self.vcal_dynamic}, TDAC={self.tdac_dynamic}"
            )

    # -------------------------------------------------------------------------
    # Chip identifier decoding
    # -------------------------------------------------------------------------
    # Decodes the configured chip identifier into detector coordinates using
    # the mapping defined in the specification book.
    def decode_chip_id(self, ChipID):
        station = ChipID // (2**12)
        layer = ((ChipID // (2**10)) % 4) + 1
        phi = ((ChipID // (2**5)) % (2**5)) + 1
        z_prime = ChipID % (2**5)
        if layer == 3:
            z = z_prime - 7
        elif layer == 4:
            z = z_prime - 6
        else:
            z = z_prime
        return station, layer, phi, z

    # -------------------------------------------------------------------------
    # Injection execution and hitmap analysis
    # -------------------------------------------------------------------------
    # Writes the injection parameters, performs the full-chip injection,
    # collects readout-counter differences, reads the DQM ROOT file and stores
    # the calculated per-chip statistics.
    def Inject(self):
        self._ensure_root()

        base = f"{self.m.odb_path_commands}/MupixInjection"
        self.run_number = int(self.seq.odb_get("/Runinfo/Run number"))

        # ---------------------------------------------------------------------
        # Injection parameter configuration
        # ---------------------------------------------------------------------
        # Writes the requested scan region, pulse count and pulse timing to
        # the injection command interface.
        self.seq.odb_set(f"{base}/Injection max column", self.max_columns)
        self.seq.odb_set(f"{base}/Injection min column", self.min_columns)
        self.seq.odb_set(f"{base}/Injection max rows", self.max_rows)
        self.seq.odb_set(f"{base}/Injection min rows", self.min_rows)
        self.seq.odb_set(f"{base}/Number of pulses", self.pulse_number)
        self.seq.odb_set(f"{base}/Wait time between pulses (ms)", self.wait)
        self.seq.odb_set(f"{base}/Injection pulse duration", self.inj_puls)

        # ---------------------------------------------------------------------
        # Initial readout counters
        # ---------------------------------------------------------------------
        # Captures the selected switching-central counters before injection so
        # the number of events produced by the scan can be evaluated.
        scso = self.seq.odb_get("/Equipment/SwitchingCentral/Variables/SCSO")
        sccn = self.seq.odb_get("/Equipment/SwitchingCentral/Variables/SCCN")

        chip_set = set(self.chip_list)
        intime_initial = []
        outoftime_initial = []
        overflow_initial = []
        SCCN_initial = sccn[25]
        sorterout_initial = scso[74]

        for asic in range(self.m.N_chips):
            for pp in self.enabled_channels:
                cfg_id = asic + self.m.feb_link[pp]
                if cfg_id not in chip_set:
                    continue
                intime_initial.append(scso[cfg_id + 2])
                outoftime_initial.append(scso[cfg_id + 14])
                overflow_initial.append(scso[cfg_id + 26])

        # ---------------------------------------------------------------------
        # Full-chip injection
        # ---------------------------------------------------------------------
        # Starts the hardware injection command and blocks until the command
        # has completed.
        self.seq.odb_set(f"{base}/Full chip Injection", True)
        while self.seq.odb_get(f"{base}/Full chip Injection"):
            time.sleep(0.1)

        run_number = self.run_number

        # ---------------------------------------------------------------------
        # Final readout counters
        # ---------------------------------------------------------------------
        # Captures the same counters after injection and computes the
        # differences associated with this scan.
        scso_f = self.seq.odb_get("/Equipment/SwitchingCentral/Variables/SCSO")
        sccn_f = self.seq.odb_get("/Equipment/SwitchingCentral/Variables/SCCN")

        intime_final = []
        outoftime_final = []
        overflow_final = []
        SCCN_final = sccn_f[25]
        sorterout_final = scso_f[74]

        for asic in range(self.m.N_chips):
            for pp in self.enabled_channels:
                cfg_id = asic + self.m.feb_link[pp]
                if cfg_id not in chip_set:
                    continue
                intime_final.append(scso_f[cfg_id + 2])
                outoftime_final.append(scso_f[cfg_id + 14])
                overflow_final.append(scso_f[cfg_id + 26])

        intime_delta = [c - i for c, i in zip(intime_final, intime_initial)]
        outoftime_delta = [c - i for c, i in zip(outoftime_final, outoftime_initial)]
        SCCN_delta = SCCN_final - SCCN_initial
        sorterout_delta = sorterout_final - sorterout_initial
        overflow_delta = [c - i for c, i in zip(overflow_final, overflow_initial)]

        # ---------------------------------------------------------------------
        # Run finalization
        # ---------------------------------------------------------------------
        # Stops data taking so the DQM histograms are finalized before the
        # ROOT output file is inspected.
        self.seq.msg("Stopping run to finalize histograms...")
        self.seq.stop_run()
        self.c.FEB_set_to_idle()

        # ---------------------------------------------------------------------
        # ROOT output file resolution
        # ---------------------------------------------------------------------
        # Resolves the DQM ROOT file written for the completed injection run. (Hardcoded parents)
        ROOT_OUTPUT_DIR = Path(__file__).resolve().parents[6]
        file_name = f"dqm/dqm_histos_{run_number:05d}.root"
        file_path = ROOT_OUTPUT_DIR / file_name

        n_pulses = self.seq.odb_get(f"{base}/Number of pulses")

        # Waits for the histogram file to be written before reading it.
        timeout_s = 10
        start_time = time.time()
        while not file_path.exists():
            if time.time() - start_time > timeout_s:
                self.seq.msg(f"Timeout: ROOT file not found: {file_path}")
                return 0
            time.sleep(0.5)

        # Allows the ROOT file writer to finish before opening the file.
        self.seq.msg(f"ROOT file found: {file_path}")
        time.sleep(2)

        # ---------------------------------------------------------------------
        # ROOT output copy
        # ---------------------------------------------------------------------
        # Copies the generated ROOT file into the QC output directory using a
        # DUT-specific output filename.
        BASE_DIR = Path(__file__).resolve().parents[2] / "python_qc" / "output"
        if self.m.dut == "chip":
            root_fname = f"root_output_injection_{self.m.partID}.root"
        else:
            root_fname = f"root_output_injection_{self.m.partID}_{self.stream}.root"

        root_target = self.m.build_output_path(
            filename=root_fname,
            directory=BASE_DIR,
            from_scratch=self.m.from_scratch,
            overwrite_last=self.m.overwrite_last,
        )

        try:
            shutil.copy2(file_path, root_target)
            self.seq.msg(f"ROOT file copied to {root_target}")
        except Exception as e:
            self.seq.msg(f"Could not copy ROOT file to {root_target}: {e}")

        # ---------------------------------------------------------------------
        # Per-chip hitmap analysis
        # ---------------------------------------------------------------------
        # Reads the hitmap associated with each selected chip and derives its
        # active, inactive and noisy pixel counts inside the injection region.
        results = {}
        chip_set = set(self.chip_list)

        for asic in range(self.m.N_chips):
            ind = 0
            for pp in self.enabled_channels:
                cfg_id = asic + self.m.feb_link[pp]
                if cfg_id not in chip_set:
                    continue

                position = self.m.get_position(cfg_id, self.m.streams[pp], self.m.feb_link[pp])
                station, layer, ladder, chip_z = self.decode_chip_id(cfg_id + 1)

                hist_name = (
                    "pixel/hitmaps/"
                    f"station_{station}/"
                    f"layer_{layer}/"
                    f"ladder_{ladder:02d}/"
                    f"hitmap_perChip_withToTCut_{chip_z:05d}"
                )

                # Classifies pixels using the minimum accepted injection
                # efficiency and uses twice that value as the noise threshold.
                threshold = float(n_pulses * self.qc_grading.min_efficiency_injection)
                stats = self.ROOT.get_injection_stats(
                    str(file_path),
                    hist_name,
                    threshold,
                    threshold * 2,
                    self.min_columns,
                    self.max_columns,
                    self.min_rows,
                    self.max_rows,
                )

                if not stats or len(stats) < 4:
                    ind += 1
                    continue

                total_pixels = int(stats[0])
                inactive_pixel = int(stats[1])
                noisy_pixel = int(stats[2])
                counts = int(stats[3])
                active_pixel = total_pixels - inactive_pixel

                # Stores either the configured default DAC values or the
                # dynamically supplied values used for the current scan.
                if self.th_high_dynamic is None:
                    results[cfg_id] = {
                        "position": position,
                        "total_pixels": total_pixels,
                        "active_pixel": active_pixel,
                        "inactive_pixel": inactive_pixel,
                        "noisy_pixel": noisy_pixel,
                        "counts": counts,
                        "VCAL": int(self.vcal),
                        "ThHigh": int(self.th_high),
                        "n_pulses": int(n_pulses),
                        "InTime": int(intime_delta[ind]),
                        "OutOfTime": int(outoftime_delta[ind]),
                        "SCCN": int(SCCN_delta),
                        "SorterOut": int(sorterout_delta),
                        "OVERFLOW": int(overflow_delta[ind]),
                        "TDAC": int(self.tdac_dynamic) if self.tdac_dynamic is not None else None,
                    }
                else:
                    results[cfg_id] = {
                        "position": position,
                        "total_pixels": total_pixels,
                        "active_pixel": active_pixel,
                        "inactive_pixel": inactive_pixel,
                        "noisy_pixel": noisy_pixel,
                        "counts": counts,
                        "VCAL": int(self.vcal_dynamic),
                        "ThHigh": int(self.th_high_dynamic),
                        "n_pulses": int(n_pulses),
                        "InTime": int(intime_delta[ind]),
                        "OutOfTime": int(outoftime_delta[ind]),
                        "SCCN": int(SCCN_delta),
                        "SorterOut": int(sorterout_delta),
                        "OVERFLOW": int(overflow_delta[ind]),
                        "TDAC": int(self.tdac_dynamic) if self.tdac_dynamic is not None else None,
                    }

                self.seq.msg(f"active_pixel = {active_pixel}")
                ind += 1

        # Stores one output record containing the environment values and all
        # successfully analyzed chips.
        offset = self.store_output_data(results)
        return offset

    # -------------------------------------------------------------------------
    # Result persistence
    # -------------------------------------------------------------------------
    # Converts the injection results into one NDJSON record containing power
    # conditions, run metadata and per-chip analysis values.
    #
    # The returned offset points to the beginning of the appended record.
    # It is used when reading out in the Optimisation/Scurve scripts.
    def store_output_data(self, results):
        env = {
            "hv_current": self.p.hv_get_current(self.enabled_channels),
            "lv_current": self.p.lv_get_current(self.enabled_channels),
            "lv_voltage": self.p.lv_get_voltage(self.enabled_channels),
            "run_number": int(self.run_number),
        }

        chips = []
        for cfg_id, info in results.items():
            chips.append({
                "cfg_id": int(cfg_id),
                "position": info["position"],
                "active_pixel": int(info["active_pixel"]),
                "total_pixels": int(info["total_pixels"]),
                "inactive_pixel": int(info["inactive_pixel"]),
                "noisy_pixel": int(info["noisy_pixel"]),
                "counts": int(info["counts"]),
                "ThHigh": int(info["ThHigh"]),
                "VCAL": int(info["VCAL"]),
                "n_pulses": int(info["n_pulses"]),
                "InTime": int(info["InTime"]),
                "OutOfTime": int(info["OutOfTime"]),
                "SCCN": int(info["SCCN"]),
                "SorterOut": int(info["SorterOut"]),
                "OVERFLOW": int(info["OVERFLOW"]),
                "TDAC": info.get("TDAC", None),
            })

        record = {"env": env, "chips": chips}

        p = Path(self.ndjson_path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.touch(exist_ok=True)

        # Appends the new record and captures the byte offset before writing.
        with open(p, "a") as f:
            f.seek(0, 2)          # ensure EOF
            offset = f.tell()     # offset BEFORE write
            f.write(json.dumps(record) + "\n")
            f.flush()

        self.seq.msg("Data saved.")
        return offset


    # -------------------------------------------------------------------------
    # Scan startup sequence
    # -------------------------------------------------------------------------
    # Prepares the FEBs, applies chip thresholds, starts data taking and then
    # executes the injection and analysis procedure.
    #
    # runstart_working controls how the run is started:
    #   True  -> call the sequencer run-start interface directly
    #   False -> start the run through the MSL script commands
    def start(self):
        self.seq.msg("Starting injection..")
        self.c.FEB_set_to_idle()
        self.c.FEB_set_bypass()
        time.sleep(1)

        self.set_thresholds()

        if not self.runstart_working:
            self.seq.msg("Starting run via Load/Start script commands")
            self.seq.odb_set("/Sequencer/State/Path", "pixels/msl_qc/generic_qc_files/")
            self.seq.odb_set("/Sequencer/Command/Load filename", "start_run.msl")
            self.seq.odb_set("/Sequencer/State/Filename", "start_run.msl")
            self.seq.odb_set("/Sequencer/Command/Load new file", True)
            self.seq.odb_set("/Sequencer/Command/Start script", True)
            self.seq.msg("Run started (via MSL script)")
        else:
            self.seq.msg("Starting run via seq.start_run()")
            self.seq.start_run()

        while self.seq.odb_get("/Runinfo/State") != 3:
            time.sleep(0.1)

        self.c.FEB_unset_bypass()
        self.c.FEB_set_to_running()

        offset = self.Inject()
        return offset