import time
import midas.client
from routines.qcRoutine_check_unmaskable import Unmaskable
from utils.qc_mapping import QC_Mapping
from utils.qc_grading import QC_Grading
from utils.qc_chip_handler import QC_ChipHandler
from utils.qc_power import PowerControl

# -----------------------------------------------------------------------------
# Unmaskable pixel scan sequence
# -----------------------------------------------------------------------------
# Registers the scan parameters, constructs the required hardware-control
# interfaces and executes the unmaskable-pixel measurement routine.
def define_params(seq):
    mapping = QC_Mapping(seq)
    seq.register_param("PulseNumber",           "Number of injection pulses",   10)
    seq.register_param("injectionWaitTime",     "Wait time per pulse (ms)",     1)
    seq.register_param("runstart_working",      "Runstart working",             True)


# -----------------------------------------------------------------------------
# Main sequence execution
# -----------------------------------------------------------------------------
# Creates the mapping, chip-control, power-control and grading interfaces, then
# runs the unmaskable-pixel scan as part of the full-QC workflow.
def sequence(seq):
    """Main sequence execution"""

    try:
        mapping = QC_Mapping(seq)  # Use sequencer's MIDAS client
        chip_handler = QC_ChipHandler(seq, mapping)  # Use sequencer's MIDAS client
        power = PowerControl(seq, mapping) # Use sequencer's MIDAS client
        grading = QC_Grading(seq, mapping)  # Use sequencer's MIDAS client

        unmaskable = Unmaskable(seq=seq, chip_handler=chip_handler, mapping=mapping, power=power, full_qc=True, QC_Grading=grading)
        unmaskable.start()

    except Exception as e:
        seq.msg(f"Error during scan: {str(e)}")
        raise

# -----------------------------------------------------------------------------
# Sequence cleanup
# -----------------------------------------------------------------------------
# Stops any remaining sequencer activity and terminates the active run when
# the sequence exits.
#
# runstart_working controls how the run is stopped:
#   True  -> stop the run through the sequencer interface directly
#   False -> stop the run through the MSL script commands
def at_exit(seq):
    """Cleanup function called when sequence exits"""
    seq.odb_set("/Sequencer/Command/Stop immediately", True)
    runstart_working = seq.get_param("runstart_working")
    if not runstart_working:
        seq.odb_set("/Sequencer/State/Path", "pixels/msl_qc/generic_qc_files/")
        seq.odb_set("/Sequencer/Command/Load filename", "stop_run.msl")
        seq.odb_set("/Sequencer/State/Filename", "stop_run.msl")
        seq.odb_set("/Sequencer/Command/Load new file", True)
        seq.odb_set("/Sequencer/Command/Start script", True)
    else:
        seq.stop_run()



    print("Scan sequence cleanup")

if __name__ == "__main__":
    start_timer = time.time()
    client = midas.client.MidasClient("UnmaskableClient")
    print("Time taken: ", time.time()-start_timer)