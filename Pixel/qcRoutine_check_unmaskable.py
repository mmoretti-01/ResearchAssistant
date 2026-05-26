import ROOT
import time
import json
import numpy as np
from collections import defaultdict
import shutil
from pathlib import Path

# -----------------------------------------------------------------------------
# Unmaskable pixel scan
# -----------------------------------------------------------------------------
# Runs checkerboard-mask injection scans and identifies pixels that still
# record hits while masked.
#
# Two complementary checkerboard masks are applied:
#   first scan  -> tests pixels selected by the standard checkerboard pattern
#   second scan -> tests pixels selected by the shifted checkerboard pattern

class Unmaskable:
    # -------------------------------------------------------------------------
    # Scan initialization
    # -------------------------------------------------------------------------
    # Stores control interfaces, configures the active detector channels and
    # resolves the output files used for the scan results.
    #
    # full_qc controls where scan parameters are read from:
    #   True  -> use the values supplied by QC_Grading
    #   False -> request values through the sequencer parameter interface

    def __init__(self, seq, chip_handler, mapping, power, full_qc=False, QC_Grading=None):
        self.seq = seq
        self.c = chip_handler
        self.m = mapping
        self.p = power
        self.full_qc = full_qc
        self.qc_grading = QC_Grading if QC_Grading else None

        # ---------------------------------------------------------------------
        # ROOT hitmap extraction helper
        # ---------------------------------------------------------------------
        # Declares the C++ helper only once in the ROOT interpreter. The helper
        # scans the active checkerboard parity and returns the number and
        # coordinates of hit pixels that remain visible while masked.
        if not hasattr(ROOT, "get_injection_stats_mask"):
            ROOT.gInterpreter.Declare(
                r"""
                #include "TFile.h"
                #include "TH2.h"
                #include <vector>


                std::vector<int> get_injection_stats_mask(const char* filename,
                                                    const char* histname,
                                                    bool shift)
                {
                    std::vector<int> out;

                    TFile f(filename, "READ");
                    if (f.IsZombie())
                        return out;

                    TH2* h = dynamic_cast<TH2*>(f.Get(histname));
                    if (!h)
                        return out;

                    int ix_min = 1, ix_max = 256;
                    int iy_min = 1, iy_max = 250;

                    int unmaskable = 0;

                    for (int ix = ix_min; ix <= ix_max; ++ix) {
                        for (int iy = iy_min; iy <= iy_max; ++iy) {

                            int parity = (ix + iy) % 2;

                            if (shift)
                                parity = (parity + 1) % 2;

                            if (parity == 0)
                                continue;

                            double c = h->GetBinContent(ix, iy);
                            if (c > 0) {
                                ++unmaskable;
                                out.push_back(ix-1);
                                out.push_back(iy-1);
                            }
                        }
                    }

                    // prepend unmaskable count
                    out.insert(out.begin(), unmaskable);

                    return out;
                }

                """
            )

        # ---------------------------------------------------------------------
        # Enabled chip and channel selection
        # ---------------------------------------------------------------------
        # Restricts the scan to chips selected by the ASIC mask and activates
        # only the relevant detector side for the requested stream.
        self.chip_list = np.array([int(x) for x in self.m.get_chip_list_from_asic_mask()])
        self.seq.msg(f"Chips to test: {self.chip_list}")

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

        self.use_QCHisto      = self.m.use_QCHisto
        self.pulse_number     = getattr(source, "PulseNumber") if self.full_qc else source("PulseNumber")
        self.wait             = getattr(source, "injectionWaitTime") if self.full_qc else source("injectionWaitTime")
        self.runstart_working = getattr(source, "runstart_working") if self.full_qc else source("runstart_working")


        # ---------------------------------------------------------------------
        # Output file configuration
        # ---------------------------------------------------------------------
        # Builds DUT-specific output names so chip tests and streamed tests
        # write independent NDJSON records and full-QC references.
        BASE_DIR = Path(__file__).resolve().parents[2] / "python_qc" / "output"
        if self.m.dut == "chip":
            fname = f"unmaskable_{self.m.partID}.ndjson"
            self.full_qc_path = BASE_DIR / f"full_QC_{self.m.partID}.json"
        else:
            fname = f"unmaskable_{self.m.partID}_{self.stream}.ndjson"
            self.full_qc_path = BASE_DIR / f"full_QC_{self.m.partID}_{self.stream}.json"


        self.ndjson_path = self.m.build_output_path(
            filename=fname,
            directory=BASE_DIR,
            from_scratch=self.m.from_scratch,
            overwrite_last=self.m.overwrite_last,
        )

    # -------------------------------------------------------------------------
    # Chip identifier decoding
    # -------------------------------------------------------------------------
    # Decodes the configured chip identifier into detector coordinates using
    # the formula defined in the specification book.
    #
    # Layer-dependent offsets convert z_prime into the physical chip-z value.
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
    # Scan execution
    # -------------------------------------------------------------------------
    # Applies the two checkerboard masks, performs one injection run for each
    # mask, reads the resulting ROOT hitmaps and stores detected pixels.
    def start(self):
        self.seq.msg("Starting scan...")
        BASE_DIR = Path(__file__).resolve().parents[2] / "python_qc" / "output" / "masks"

        # ---------------------------------------------------------------------
        # Injection scan region
        # ---------------------------------------------------------------------
        # Configures the pixel area used by the full-chip injection command.
        base = f"{self.m.odb_path_commands}/MupixInjection"
        self.seq.odb_set(f"{base}/Injection min column", 100)
        self.seq.odb_set(f"{base}/Injection max column", 200)
        self.seq.odb_set(f"{base}/Injection min rows", 0)
        self.seq.odb_set(f"{base}/Injection max rows", 50)

        lvds_info = []

        # ---------------------------------------------------------------------
        # Complementary checkerboard scans
        # ---------------------------------------------------------------------
        # Runs two full-chip injection scans so both pixel parities are tested:
        #   k = 0 -> use the standard checkerboard mask
        #   k = 1 -> use the shifted checkerboard mask
        for k in range(2):
            for asic in range(self.m.N_chips):
                for pp in self.enabled_channels:
                    cfg_id = asic + self.m.feb_link[pp]
                    if cfg_id not in self.chip_list:
                        continue

                    # Copies the selected pattern into the per-chip mask file
                    # consumed by the TDAC configuration command.
                    fname = f"mask_{self.m.partID}_C{cfg_id + 1}.bin"
                    mask_path = BASE_DIR / fname
                    if k == 0:
                        src = BASE_DIR / "checker.bin"
                    else:
                        src = BASE_DIR / "checker_shift.bin"
                    shutil.copyfile(src, mask_path)

                    # Applies the chip mask and blocks until the configuration
                    # command reports completion.
                    self.seq.odb_set("/Equipment/PixelsCentral/Commands/MupixTDACConfig", True)
                    while self.seq.odb_get("/Equipment/PixelsCentral/Commands/MupixTDACConfig"):
                        time.sleep(0.1)
                    self.seq.msg(f"Mask applyed to chip {cfg_id}")

            # -----------------------------------------------------------------
            # Run startup and FEB preparation
            # -----------------------------------------------------------------
            # Resets and prepares the FEBs before starting data taking.
            self.c.Reset_PLL_all(chip_list=self.chip_list)
            self.seq.msg("PLL reset done")

            self.c.FEB_set_to_idle()
            self.c.FEB_set_bypass()
            if not self.runstart_working:
                self.seq.msg("Starting run via Load/Start script commands")
                self.seq.odb_set("/Sequencer/State/Path", "pixels/msl_qc/generic_qc_files/")
                self.seq.odb_set("/Sequencer/Command/Load filename", "start_run.msl")
                self.seq.odb_set("/Sequencer/State/Filename", "start_run.msl")
                self.seq.odb_set("/Sequencer/Command/Load new file", True)
                self.seq.odb_set("/Sequencer/Command/Start script", True)
                self.seq.msg("Run started")

            else:
                self.seq.start_run()

            while self.seq.odb_get("/Runinfo/State") != 3:
                time.sleep(0.1)

            self.c.FEB_unset_bypass()
            self.c.FEB_set_to_running()

            # -----------------------------------------------------------------
            # Injection and LVDS diagnostic collection
            # -----------------------------------------------------------------
            # Records selected LVDS counters before and after injection so the
            # run retains a diagnostic difference for each checkerboard mask.
            base = f"{self.m.odb_path_commands}/MupixInjection"
            lvds_initial = self.seq.odb_get(f"{self.m.odb_path_pixel_variables}/PCLS")[0:25]
            self.seq.odb_set(f"{base}/Full chip Injection", True)
            while self.seq.odb_get(f"{base}/Full chip Injection"):
                time.sleep(0.1)

            lvds_final = self.seq.odb_get(f"{self.m.odb_path_pixel_variables}/PCLS")[0:25]

            indices = [15, 16, 19, 20, 23, 24]
            lvds_diff = [lvds_final[i] - lvds_initial[i] for i in indices]
            lvds_info.append(lvds_diff)

            self.seq.msg("Stopping run to finalize histograms...")
            self.seq.stop_run()

        # ---------------------------------------------------------------------
        # ROOT output file resolution
        # ---------------------------------------------------------------------
        # The scans produce consecutive ROOT files:
        #   run_number - 1 -> standard checkerboard mask
        #   run_number     -> shifted checkerboard mask
        run_number = int(self.seq.odb_get("/Runinfo/Run number"))
        self.seq.msg(f"run_number{run_number}")
        self.seq.msg(f"lvds_info{lvds_info}")

        ROOT_OUTPUT_DIR = Path(__file__).resolve().parents[6]
        file_name_0 = f"root_output_files/dqm_histos_{run_number-1:05d}.root"
        file_path_0 = ROOT_OUTPUT_DIR / file_name_0
        file_name_1 = f"root_output_files/dqm_histos_{run_number:05d}.root"
        file_path_1 = ROOT_OUTPUT_DIR / file_name_1

        timeout_s = 10
        start_time = time.time()
        while not file_path_1.exists() or not file_path_0.exists():
            if time.time() - start_time > timeout_s:
                self.seq.msg(f"Timeout: ROOT file not found: {file_path_0, file_path_1}")
                return
            time.sleep(0.5)

        self.seq.msg(f"ROOT file found: {file_path_0, file_path_1}")
        time.sleep(2)

        # ---------------------------------------------------------------------
        # Hitmap analysis
        # ---------------------------------------------------------------------
        # Extracts masked pixels with remaining hits from each relevant
        # per-chip hitmap and merges coordinates from both checkerboard scans.
        chip_set = set(self.chip_list)
        results = {}

        for asic in range(self.m.N_chips):
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

                stats_0 = ROOT.get_injection_stats_mask(str(file_path_0), hist_name, False)
                stats_1 = ROOT.get_injection_stats_mask(str(file_path_1), hist_name, True)

                # Each statistics vector stores:
                #   element 0      -> number of detected unmaskable pixels
                #   remaining data -> flattened x/y coordinate pairs
                if len(stats_0) == 0 and len(stats_1) == 0:
                    unmaskable = 0
                    ix = []
                    iy = []
                else:
                    unmaskable = int(stats_0[0]) + int(stats_1[0])
                    ix = []
                    iy = []
                    for i in range(1, len(stats_0), 2):
                        ix.append(int(stats_0[i]))
                        iy.append(int(stats_0[i + 1]))
                    for i in range(1, len(stats_1), 2):
                        ix.append(int(stats_1[i]))
                        iy.append(int(stats_1[i + 1]))

                results[cfg_id] = {
                        "position": position,
                        "unmaskable": unmaskable,
                        "positions": list(zip(ix, iy)),
                }

        offset = self.store_output_data(results)
        return offset


    # -------------------------------------------------------------------------
    # Result persistence
    # -------------------------------------------------------------------------
    # Converts the per-chip scan results into one NDJSON record and returns
    # the file offset at which that record was appended.

    def store_output_data(self, results):

        chips = []
        for cfg_id, info in results.items():
            chips.append({
                "cfg_id": cfg_id,
                "position": info["position"],
                "n_unmaskable": info["unmaskable"],
                "unmaskable_pixels": info["positions"],
            })

        record = {
            "chips": chips,
        }

        with open(self.ndjson_path, "a") as f:
            offset = f.tell()
            f.write(json.dumps(record) + "\n")
            f.flush()

        self.seq.msg("Unmaskable data saved.")
        return offset
