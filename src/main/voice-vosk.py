"""Local Vosk worker. JSON lines only; audio never leaves this process.
Microphone input is created ONLY by an explicit listen command. File replay is
available only with --test-audio-directory and never opens an input device.
"""
import argparse
import json
import queue
import re
import sys
import threading
import time
import wave
from pathlib import Path


def phrase_words(text):
    # The Portuguese model knows these two English loanwords separately.
    text = re.sub(r"\bcodebit\b", "code bit", text.lower())
    return re.findall(r"[^\W\d_]+", text, flags=re.UNICODE)


def recognized_result(result, mode, phrase):
    words = result.get("result", [])
    if mode == "wake":
        wanted = phrase_words(phrase)
        # Do not force arbitrary speech into a wake phrase: the grammar also
        # has [unk], and the full phrase must occur as consecutive known words.
        tokens = [w["word"] for w in words]
        for offset in range(len(tokens) - len(wanted) + 1):
            if tokens[offset:offset + len(wanted)] == wanted:
                confidence = min(w["conf"] for w in words[offset:offset + len(wanted)])
                if confidence >= 0.65:
                    return phrase, confidence
        return "", 0
    text = result.get("text", "").strip()
    confidence = sum(w.get("conf", 0) for w in words) / max(1, len(words))
    return text, confidence


class Worker:
    def __init__(self, model_path, test_directory=None, emit=None):
        from vosk import Model, KaldiRecognizer, SetLogLevel
        SetLogLevel(-1)
        self.Model, self.Recognizer = Model, KaldiRecognizer
        self.model_path = model_path
        self.test_directory = Path(test_directory).resolve() if test_directory else None
        self.emit = emit or (lambda e: print(json.dumps(e, ensure_ascii=False), flush=True))
        self.model = None
        self.stream = None
        self.audio = queue.Queue(maxsize=64)
        self.failure = None
        self.recognizer = None
        self.mode = None
        self.request_id = ""
        self.phrase = ""
        self.deadline = 0
        self.replay = None

    def load(self):
        if self.model is None:
            # Explicit path: never Model(lang=...), which can download models.
            self.model = self.Model(str(self.model_path))

    def halt(self):
        if self.stream is not None:
            stream, self.stream = self.stream, None
            stream.abort()
            stream.close()
        if self.replay is not None:
            self.replay.close()
            self.replay = None
        self.mode = None
        self.recognizer = None
        self.failure = None
        while not self.audio.empty():
            try:
                self.audio.get_nowait()
            except queue.Empty:
                break

    def command(self, c):
        command = c.get("command")
        if command == "probe":
            self.load()
            import sounddevice
            sounddevice.get_portaudio_version()  # library availability; no device opened
            self.emit({"type": "capabilities", "recognizers": [{"id": "vosk-pt", "name": "Vosk português · local", "culture": "pt-BR"}], "voices": []})
        elif command == "pause":
            self.halt()
            self.emit({"type": "paused", "requestId": c.get("requestId")})
        elif command == "listen":
            self.halt()
            self.load()
            self.mode = c["mode"]
            if self.mode not in ("wake", "dictation"):
                raise ValueError("Modo de reconhecimento inválido")
            self.phrase = c.get("wakePhrase", "Ei, Codebit")
            self.request_id = str(c["requestId"])
            if self.mode == "wake":
                words = phrase_words(self.phrase)
                if len(words) < 2:
                    raise ValueError("Use uma frase de ativação com pelo menos duas palavras.")
                unknown = [w for w in words if self.model.vosk_model_find_word(w) < 0]
                if unknown:
                    raise ValueError("Palavras fora do vocabulário local: " + ", ".join(unknown) + ". Tente Ei, Codebit ou Olá computador.")
                self.recognizer = self.Recognizer(self.model, 16000, json.dumps([" ".join(words), "[unk]"], ensure_ascii=False))
            else:
                self.recognizer = self.Recognizer(self.model, 16000)
            self.recognizer.SetWords(True)
            if self.test_directory:
                source = Path(c.get("audioFile", "")).resolve()
                if not source.is_relative_to(self.test_directory) or source.suffix.lower() != ".wav":
                    raise ValueError("Arquivo de teste fora do diretório permitido")
                self.replay = wave.open(str(source), "rb")
                if (self.replay.getnchannels(), self.replay.getsampwidth(), self.replay.getframerate()) != (1, 2, 16000):
                    raise ValueError("O teste exige WAV PCM mono de 16 bits, 16000 Hz")
            else:
                if "audioFile" in c:
                    raise ValueError("Reprodução de teste não está habilitada")
                import sounddevice as sd
                def callback(data, frames, stamp, status):
                    if status:
                        self.failure = "Falha no fluxo de áudio: " + str(status)
                        return
                    try:
                        self.audio.put_nowait(bytes(data))
                    except queue.Full:
                        self.failure = "O processamento não acompanhou o microfone. A captura foi interrompida."
                self.stream = sd.RawInputStream(samplerate=16000, blocksize=1600, dtype="int16", channels=1, callback=callback)
                self.stream.start()
            self.deadline = time.monotonic() + (15 if self.mode == "wake" else 20)
            self.emit({"type": "listening", "mode": self.mode, "requestId": self.request_id})
        else:
            raise ValueError("Comando desconhecido")

    def finish(self, result):
        mode, request_id = self.mode, self.request_id
        text, confidence = recognized_result(result, mode, self.phrase)
        self.halt()  # release input BEFORE publishing a transcript or starting TTS
        self.emit({"type": "recognized", "mode": mode, "requestId": request_id, "text": text, "confidence": confidence})

    def tick(self):
        if not self.mode:
            return
        if self.failure:
            raise RuntimeError(self.failure)
        if self.replay:
            data = self.replay.readframes(1600)
            if not data:
                self.finish(json.loads(self.recognizer.FinalResult()))
                return
        else:
            try:
                data = self.audio.get_nowait()
            except queue.Empty:
                data = b""
        if data and self.recognizer.AcceptWaveform(data):
            result = json.loads(self.recognizer.Result())
            text, _ = recognized_result(result, self.mode, self.phrase)
            if text:
                self.finish(result)
                return
        if time.monotonic() >= self.deadline:
            self.finish(json.loads(self.recognizer.FinalResult()))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--test-audio-directory")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
    inbox = queue.Queue()
    def read():
        for line in sys.stdin:
            inbox.put(line)
        inbox.put(None)
    threading.Thread(target=read, daemon=True).start()
    worker = None
    try:
        worker = Worker(args.model, args.test_audio_directory)
        while True:
            try:
                line = inbox.get_nowait()
                if line is None:
                    break
                command = json.loads(line)
                if command.get("command") == "stop":
                    break
                worker.command(command)
            except queue.Empty:
                pass
            worker.tick()
            time.sleep(0.01)
    except Exception as e:
        if worker:
            worker.halt()
        print(json.dumps({"type": "error", "message": str(e)}, ensure_ascii=False), flush=True)
    finally:
        if worker:
            worker.halt()


if __name__ == "__main__":
    main()
