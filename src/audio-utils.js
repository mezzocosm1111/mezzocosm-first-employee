
import pkg from 'alawmulaw';
const { mulaw } = pkg;

/**
 * Robust Transcoding using alawmulaw (Codec) + Linear Interpolation (Resampling).
 * 
 * Strategy:
 * 1. Codec: Use Lookup Tables (u-law <-> PCM16) for perfect byte alignment.
 * 2. Resampling: Use Linear Interpolation.
 *    - Smoother than "Nearest Neighbor" (Dropping/Doubling).
 *    - Safer than "Polyphase" (No complex buffering/filters causing static).
 */

// --- Transcode: Twilio (8k u-law) -> Grok (24k PCM16) ---
export function ulawToPcm16(ulawBuffer) {
    // 1. Decode u-law to PCM16 (8000 Hz)
    // alawmulaw returns an array of 16-bit integers
    const pcmSamples8k = [];
    for (let i = 0; i < ulawBuffer.length; i++) {
        pcmSamples8k.push(mulaw.decode(ulawBuffer[i]));
    }

    // 2. Upsample 8k -> 24k (Factor 3x)
    // Linear Interpolation: 
    // Val[0] ... (interpolated) ... (interpolated) ... Val[1]
    const pcmSamples24k = new Int16Array(pcmSamples8k.length * 3);

    for (let i = 0; i < pcmSamples8k.length - 1; i++) {
        const valA = pcmSamples8k[i];
        const valB = pcmSamples8k[i + 1];

        // Sample 1 (Original)
        pcmSamples24k[i * 3] = valA;
        // Sample 2 (1/3 way)
        pcmSamples24k[i * 3 + 1] = valA + (valB - valA) * 0.33;
        // Sample 3 (2/3 way)
        pcmSamples24k[i * 3 + 2] = valA + (valB - valA) * 0.66;
    }
    // Handle last sample (just repeat, trivial edge case)
    const lastIdx = pcmSamples8k.length - 1;
    if (lastIdx >= 0) {
        pcmSamples24k[lastIdx * 3] = pcmSamples8k[lastIdx];
        pcmSamples24k[lastIdx * 3 + 1] = pcmSamples8k[lastIdx];
        pcmSamples24k[lastIdx * 3 + 2] = pcmSamples8k[lastIdx];
    }

    // 3. To Buffer
    return Buffer.from(pcmSamples24k.buffer);
}

// --- Transcode: Grok (24k PCM16) -> Twilio (8k u-law) ---
export function pcm16ToUlaw(pcmBuffer, inputRate = 24000) {
    // 1. View buffer as Int16Array
    // Ensure we handle byte offset if buffer is part of larger pool (rare in node, but good practice)
    // Actually Buffer.buffer might point to entire pool. Use byteOffset.
    const pcmSamples24k = new Int16Array(
        pcmBuffer.buffer,
        pcmBuffer.byteOffset,
        pcmBuffer.length / 2
    );

    // 2. Downsample 24k -> 8k (Decimation with simple smoothing)
    // We take every 3rd sample.
    // To reduce aliasing (which causes the "Garbled" sound), we can average the 3 neighbors.
    // Boxcar Filter (Window size 3).
    const targetLength = Math.floor(pcmSamples24k.length / 3);
    const ulawBuffer = Buffer.alloc(targetLength);

    for (let i = 0; i < targetLength; i++) {
        const idx = i * 3;
        // Simple averaging of 3 samples [idx, idx+1, idx+2]
        // This is a basic Low Pass Filter.
        let sum = pcmSamples24k[idx];
        if (idx + 1 < pcmSamples24k.length) sum += pcmSamples24k[idx + 1];
        if (idx + 2 < pcmSamples24k.length) sum += pcmSamples24k[idx + 2];

        const avg = Math.floor(sum / 3);

        // 3. Encode to u-law
        ulawBuffer[i] = mulaw.encode(avg);
    }

    return ulawBuffer;
}
