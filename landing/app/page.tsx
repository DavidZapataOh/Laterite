import { Hero } from "@/components/hero";
import { Nav } from "@/components/nav";

export default function Home() {
  return (
    <>
      <Nav />
      <main id="main">
        <Hero />
      </main>
    </>
  );
}
