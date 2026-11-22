"""One bounded model bundle per inference process, keyed by verified identity."""
class ModelPool:
    def __init__(self):
        self.key = None
        self.bundle = None

    def get(self, key, loader):
        if self.key != key:
            self.clear()
            bundle = loader()
            self.bundle, self.key = bundle, key
        return self.bundle

    def clear(self):
        self.key = None
        self.bundle = None
