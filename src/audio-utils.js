/**
 * Audio Utility for converting between G.711 u-law (Twilio) and PCM 16-bit (Gemini).
 * 
 * Twilio: 8000Hz, 1 channel, u-law (8-bit)
 * Gemini: 16000Hz or 24000Hz, 1 channel, PCM (16-bit)
 * 
 * We need to:
 * 1. Expand 8-bit u-law to 16-bit PCM.
 * 2. Upsample 8kHz to 16kHz (simple linear interpolation or doubling).
 * 3. Downsample 16kHz/24kHz PCM back to 8kHz.
 * 4. Compress 16-bit PCM to 8-bit u-law.
 */

// --- Precomputed Lookup Tables for u-law ---
// g711.js algorithm style
const ULAW_BIAS = 0x84;
const CLIP = 8159;

const seg_u = [
    0x3F, 0x3E, 0x3C, 0x38, 0x30, 0x20, 0x00, 0x00
];

const st_u = [
    0x1E, 0x0C, 0x06, 0x03, 0x00, 0x00, 0x00, 0x00
];

function ulawToLinear(u_val) {
    u_val = ~u_val;
    let t = ((u_val & 0x0F) << 3) + ULAW_BIAS;
    t <<= (u_val & 0x70) >> 4;
    return ((u_val & 0x80) ? (ULAW_BIAS - t) : (t - ULAW_BIAS));
}

function linearToUlaw(pcm_val) {
    let mask;
    let seg;
    let uval;

    if (pcm_val < 0) {
        pcm_val = ULAW_BIAS - pcm_val;
        mask = 0x7F;
    } else {
        pcm_val = pcm_val + ULAW_BIAS;
        mask = 0xFF;
    }

    if (pcm_val > CLIP) pcm_val = CLIP;

    seg = 8;
    for (let i = 0; i < 8; i++) {
        if (pcm_val <= (0x3F << (i + 3)) + ULAW_BIAS) {
            seg = i;
            break;
        }
    }

    if (seg >= 8) return (0x7F ^ mask);

    uval = (pcm_val - ULAW_BIAS) >>> (seg + 3);
    return ((uval + (seg << 4)) ^ mask);
}

/**
 * Converts a Buffer of u-law bytes (8kHz) to a Buffer of PCM16LE (16kHz).
 * Perform simple upsampling (sample doubling) to go 8k -> 16k.
 */
export function ulawToPcm16(ulawBuffer) {
    const samples = ulawBuffer.length;
    // 1 input byte = 2 output samples (doubling) * 2 bytes/sample = 4x size
    const pcmBuffer = Buffer.alloc(samples * 4);

    for (let i = 0; i < samples; i++) {
        const ulawByte = ulawBuffer[i];
        const pcmVal = ulawToLinear(ulawByte);

        // Write twice (upsampling by repetition/doubling)
        // Offset i * 4
        pcmBuffer.writeInt16LE(pcmVal, i * 4);
        pcmBuffer.writeInt16LE(pcmVal, i * 4 + 2);
    }

    return pcmBuffer;
}

export function pcm16ToUlaw(pcmBuffer, inputRate = 24000) {
    // 8000 Hz target
    const targetRate = 8000;
    const ratio = inputRate / targetRate; // e.g. 3 for 24k -> 8k
    const inputSamples = pcmBuffer.length / 2;
    const outputSamples = Math.floor(inputSamples / ratio);
    const ulawBuffer = Buffer.alloc(outputSamples);

    for (let i = 0; i < outputSamples; i++) {
        const inputIndex = Math.floor(i * ratio);
        // Read 16-bit LE
        const pcmVal = pcmBuffer.readInt16LE(inputIndex * 2);
        ulawBuffer[i] = linearToUlaw(pcmVal);
    }

    return ulawBuffer;
}
