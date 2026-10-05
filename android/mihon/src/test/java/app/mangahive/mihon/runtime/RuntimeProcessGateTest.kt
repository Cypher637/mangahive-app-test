package app.mangahive.mihon.runtime

import app.mangahive.mihon.loader.PathClassLoaderFactory
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class RuntimeProcessGateTest {
    @After fun reset() { RuntimeProcessGate.setOpenForTests(false) }

    @Test fun processNameMustBeExactlyTheMihonSuffix() {
        assertTrue(RuntimeProcessGate.isRuntimeProcessName("app.mangahive:mihon", "app.mangahive"))
        assertFalse(RuntimeProcessGate.isRuntimeProcessName("app.mangahive", "app.mangahive"))
        assertFalse(RuntimeProcessGate.isRuntimeProcessName("app.mangahive:mihonx", "app.mangahive"))
        assertFalse(RuntimeProcessGate.isRuntimeProcessName(null, "app.mangahive"))
    }

    @Test fun classLoaderFactoryRefusesWhileTheGateIsClosed() {
        RuntimeProcessGate.setOpenForTests(false)
        try {
            PathClassLoaderFactory().create(File("x.apk"), "a.b.c", ClassLoader.getSystemClassLoader())
            throw AssertionError("a ClassLoader was created in a process that is not :mihon")
        } catch (_: IllegalStateException) { /* expected */ }
    }
}
