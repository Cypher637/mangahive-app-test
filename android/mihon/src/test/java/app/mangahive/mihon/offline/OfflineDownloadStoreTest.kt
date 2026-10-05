package app.mangahive.mihon.offline

import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files

class OfflineDownloadStoreTest {
    @Test fun identityIsStableAndPathIsNotUserControlled() {
        val id = DownloadIdentity("manga/../x", "chapter:1", "ext", "source", "remote")
        val root = Files.createTempDirectory("mh-download").toFile()
        val path = OfflineDownloadPathPolicy(root).chapterDir(id)
        assertTrue(path.canonicalPath.startsWith(root.canonicalPath + File.separator))
        assertEquals(64, path.name.length)
        root.deleteRecursively()
    }

    @Test fun atomicStoreValidatesManifestAndCanDelete() {
        val root = Files.createTempDirectory("mh-download").toFile()
        val input = File(root, "input.bin").apply { writeBytes("page".toByteArray()) }
        val id = DownloadIdentity("m", "c", "e", "s", "r")
        val store = OfflineDownloadStore(File(root, "downloads"))
        store.writeAtomically(id, listOf(input), listOf("image/jpeg"))
        assertTrue(store.validate(id))
        assertTrue(store.delete(id))
        assertFalse(store.validate(id))
        root.deleteRecursively()
    }
}
