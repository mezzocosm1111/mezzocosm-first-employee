
import { mulaw } from 'alawmulaw';
try {
    const encoded = mulaw.encode(100);
    console.log("Success: Encoded sample", encoded);
} catch (e) {
    console.error("FAIL:", e);
}
