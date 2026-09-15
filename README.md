### Description
Closes #69

This PR updates how we handle channel labels and device profiles between the server and frontend. Instead of hardcoding "Ch 1", "Ch 2", etc., on the frontend and relying on internal backend flags to figure out the hardware type, the server now passes the actual device name and the current channel labels in the initial WebSocket connection payload.

This ensures the frontend correctly reflects the current hardware (e.g., 8-channel vs 16-channel clinical layouts) and immediately updates if the user configures custom LSL groupings.

### Summary of Changes

#### Backend (Python)
- Added a `device_profile_name` property to `AcquisitionLoop` so it's easier to grab the active hardware string (like `ironbci8`, `pieeg16`, `mock`, etc.).
- Added an `update_cached_labels()` method to `PiEEGServer` to pre-build the channel names array in memory. It checks for custom LSL groups first, then falls back to standard 10-20 clinical layouts based on the channel count.
- Updated the WebSocket `welcome` dictionary to include `"device"` and `"channel_labels"`.

#### Frontend (React)
- Updated the `useEEG` hook to read `welcome.device` and `welcome.channel_labels` and store them in state.
- Passed the dynamic `channelLabels` array down through `App.tsx` into the visualization components.
- Modified `ChannelCanvas`, `ChannelDetailPanel`, and `SessionViewer` to use the passed label (e.g., `Fp1`, `C3`) and fallback to `Ch X` if it's undefined.

### Verification & Testing
- Ran the test suite locally via `pytest` (265 passed, 1 skipped).
- Tested manually with the mock backend and dashboard to verify that the new channel labels render correctly in the UI without causing any lag in the rendering loop.
