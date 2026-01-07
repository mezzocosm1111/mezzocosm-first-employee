
import pkg from 'wavefile';
const { WaveFile } = pkg;

/**
 * High-Quality Transcoding using WaveFile (Polyphase Resampling).
 * 
 * NOTE: We must extract the RAW samples to avoid "Static" caused by WAV Headers.
 */

// --- Transcode: Twilio (8k u-law) -> Grok (24k PCM16) ---
export function ulawToPcm16(ulawBuffer) {
    try {
        const wav = new WaveFile();
        // 1. Create a WAV container from the raw u-law bytes
        // fromScratch(numChannels, sampleRate, bitDepth, samples)
        wav.fromScratch(1, 8000, '8m', ulawBuffer);

        // 2. Transcode
        wav.fromMuLaw();       // Convert to Linear PCM (16-bit by default internal)
        wav.toSampleRate(24000); // High-quality upsampling

        // 3. Extract RAW samples (Type: Uint8Array viewing Int16LE)
        // wav.data.samples is the raw byte buffer of the samples.
        return Buffer.from(wav.data.samples);
    } catch (e) {
        console.error("ulawToPcm16 Error:", e);
        return Buffer.alloc(0);
    }
}

// --- Transcode: Grok (24k PCM16) -> Twilio (8k u-law) ---
export function pcm16ToUlaw(pcmBuffer, inputRate = 24000) {
    try {
        const wav = new WaveFile();
        // 1. Load raw PCM16 samples
        wav.fromScratch(1, inputRate, '16', pcmBuffer);

        // 2. Transcode
        wav.toSampleRate(8000); // High-quality downsampling (Polyphase)
        wav.toMuLaw();          // Convert to u-law

        // 3. Extract RAW samples
        // For '8m' (u-law), samples are 8-bit.
        return Buffer.from(wav.data.samples);
    } catch (e) {
        console.error("pcm16ToUlaw Error:", e);
        return Buffer.alloc(0);
    }
}
