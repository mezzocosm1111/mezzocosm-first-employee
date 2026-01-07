
import pkg from 'alawmulaw';
const { mulaw } = pkg;

/**
 * Robust Transcoding using alawmulaw (Codec).
 * 
 * Strategy:
 * 1. Input (Twilio -> Grok): Managed natively by Grok (Native g711 support confirmed).
 * 2. Output (Grok -> Twilio): Grok sends PCM16 (despite config). We downsample and encode.
 */

// --- Transcode: Grok (24k PCM16) -> Twilio (8k u-law) ---
export function pcm16ToUlaw(pcmBuffer, inputRate = 24000) {
    // 1. View buffer as Int16Array (System Endianness, usually LE on Node)
    const pcmSamples = new Int16Array(
        pcmBuffer.buffer,
        pcmBuffer.byteOffset,
        pcmBuffer.length / 2
    );

    // 2. Downsample (Decimation: Keep 1 out of Ratio samples)
    const targetRate = 8000;
    const ratio = Math.floor(inputRate / targetRate); // e.g. 3 for 24k -> 8k

    // Safety check
    if (ratio < 1) return Buffer.alloc(0);

    const outputLength = Math.floor(pcmSamples.length / ratio);
    const ulawBuffer = Buffer.alloc(outputLength);

    for (let i = 0; i < outputLength; i++) {
        // Simple Decimation (Skip samples) - robust and static-free
        const sample = pcmSamples[i * ratio];

        // 3. Encode to u-law
        ulawBuffer[i] = mulaw.encode(sample);
    }

    return ulawBuffer;
}
