/**
 * Audio Utility for converting between G.711 u-law (Twilio) and PCM 16-bit (Gemini).
 * USES 'wavefile' LIBRARY FOR HIGH QUALITY RESAMPLING.
 */
import { WaveFile } from 'wavefile';

/**
 * Converts a Buffer of u-law bytes (8kHz) to a Buffer of PCM16LE (16kHz).
 * Uses wavefile library for decoding and resampling.
 */
export function ulawToPcm16(ulawBuffer) {
    try {
        const wav = new WaveFile();
        // 1. Create a wav from the u-law buffer
        // '8000' sample rate, '8' bit depth, '1' channel
        wav.fromScratch(1, 8000, '8', ulawBuffer);

        // 2. Decode u-law to PCM (internally converts to 16-bit or something manageable)
        wav.fromMuLaw();

        // 3. Resample to 16000Hz (Gemini Input)
        wav.toSampleRate(16000);

        // 4. Get samples as Buffer (PCM 16-bit Little Endian)
        return Buffer.from(wav.data.samples);
    } catch (e) {
        console.error("Audio Transcode Error (Uplink):", e);
        // Fallback or return silence/empty
        return Buffer.alloc(0);
    }
}

/**
 * Converts a Buffer of PCM16LE (16kHz or 24kHz) to a Buffer of u-law (8kHz).
 * Uses wavefile library for Polyphase resampling (anti-aliased) and encoding.
 * 
 * @param {Buffer} pcmBuffer Input PCM 16-bit Little Endian
 * @param {number} inputRate Source Sample Rate (default 24000 for Gemini output usually)
 */
export function pcm16ToUlaw(pcmBuffer, inputRate = 24000) {
    try {
        const wav = new WaveFile();
        // 1. Load PCM data
        // WaveFile expects 8/16/24/32 bit data. We have 16-bit Buffer.
        // fromScratch(numChannels, sampleRate, bitDepth, samples)
        wav.fromScratch(1, inputRate, '16', pcmBuffer);

        // 2. Resample to 8000Hz (Twilio)
        // This handles the anti-aliasing logic internally
        wav.toSampleRate(8000);

        // 3. Compress to u-law
        wav.toMuLaw();

        // 4. Return the data samples (which are now u-law bytes)
        return Buffer.from(wav.data.samples);
    } catch (e) {
        console.error("Audio Transcode Error (Downlink):", e);
        return Buffer.alloc(0);
    }
}
