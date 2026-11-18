"""支持 `python3 -m wepack` 直接调用。"""

from .cli import main

if __name__ == "__main__":
    raise SystemExit(main())