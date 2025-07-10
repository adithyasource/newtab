const textArea = document.getElementById("textarea");
const fontSidebar = document.getElementById("fontsidebar");
const sideBar = document.getElementById("sidebar");
const hoverChecker = document.getElementById("hoverchecker");
const changeFont = document.getElementById("changefont");
const pageBody = document.getElementById("body");
const darkModeBtn = document.getElementById("darkmodebtn");
const sideButton = document.querySelectorAll(".sidebutton");
const dropDown = document.getElementById("dropdown");
var fontTimer;
var sidebarTimer;
let stickyIdCounter = 0;
let isBlur;
let isDarkMode;

function getData() {
  isBlur = JSON.parse(localStorage.getItem("isBlur"));
  if (isBlur === null) {
    isBlur = false;
    localStorage.setItem("isBlur", false);
    localStorage.setItem("isBlur", isBlur);
  }

  if (isBlur) {
    pageBody.classList.add("blur");
  } else {
    pageBody.classList.remove("blur");
  }

  isDarkMode = JSON.parse(localStorage.getItem("isDarkMode"));
  if (isDarkMode === null) {
    isDarkMode = false;
    localStorage.setItem("isDarkMode", false);
    localStorage.setItem("isDarkMode", isDarkMode);
  }
  if (isDarkMode) {
    darkUI();
  } else {
    lightUI();
  }

  textArea.innerHTML = localStorage.getItem("textareaValue");

  // make sure that running get data refreshes data and doesnt add anything
  document.querySelectorAll(".sticky-note").forEach((el) => el.remove());

  const savedNotes = JSON.parse(localStorage.getItem("stickyNotes")) || [];
  savedNotes.forEach((note) => createStickyNote(note));

  let fontIndex = localStorage.getItem("fontIndex");
  console.log(fontIndex);
  if (fontIndex === null) {
    fontIndex = 0;
  }
  const fontLocalStorage = dropDown.options[fontIndex];
  dropDown.selectedIndex = fontIndex;
  document.body.style.fontFamily = fontLocalStorage.value;
  localStorage.setItem("fontIndex", fontIndex);

  // checks device color scheme and changes favicon color accordingly
  var favIcon = document.getElementById("favicon");
  var browserIsDark = window.matchMedia("(prefers-color-scheme: dark)");
  if (browserIsDark.matches) {
    favIcon.href = "/images/128-light.png";
  } else {
    favIcon.href = "/images/128.png";
  }
}

function attachEventListeners() {
  darkModeBtn.addEventListener("click", toggleDarkMode);
  document.getElementById("downloadtxt").addEventListener("click", downloadTxt);

  // checks for any changes in the font selector and saves it to localStorage also remembers the index of that option
  dropDown.addEventListener("change", () => {
    const selectedOption = dropDown.options[dropDown.selectedIndex].value;
    localStorage.setItem("fontIndex", dropDown.selectedIndex);
    pageBody.style.fontFamily = selectedOption;

    sideBar.style.animationName = "out";
    fontSidebar.style.visibility = "hidden";
    sideBar.style.visibility = "hidden";

    hoverChecker.style.width = "1.3vw";
    hoverChecker.style.height = "13em";
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      console.log("user came back");
      getData();
    } else {
      console.log("user left the page");
    }
  });

  // checks if changeFont button is clicked
  changeFont.addEventListener("click", () => {
    fontSidebar.style.visibility = "visible";
  });

  // checks if a certain part of the screen is being hovered on for a period of time and then makes the sidebar visible
  hoverChecker.addEventListener("mouseenter", () => {
    sideBar.style.visibility = "visible";
    sideBar.style.animationName = "in";

    hoverChecker.style.width = "40vw";
    hoverChecker.style.height = "10em";
  });

  hoverChecker.addEventListener("mouseleave", () => {
    sideBar.style.animationName = "out";
    fontSidebar.style.visibility = "hidden";
    sideBar.style.visibility = "hidden";

    hoverChecker.style.width = "1.3vw";
    hoverChecker.style.height = "13em";
  });
}

function createStickyNote(noteData = null) {
  stickyIdCounter++;

  const id = noteData?.id || `sticky-${stickyIdCounter}`;
  const x = noteData?.left || 100 + stickyIdCounter * 20;
  const y = noteData?.top || 100 + stickyIdCounter * 20;
  const content = noteData?.content || "";

  // Set default width and height if not defined
  const width = noteData?.width || 400;
  const height = noteData?.height || 300;

  const sticky = document.createElement("div");
  sticky.classList.add("sticky-note");
  sticky.setAttribute("id", id);
  sticky.style.left = `${x}px`;
  sticky.style.top = `${y}px`;
  sticky.style.width = `${width}px`;
  sticky.style.height = `${height}px`;

  sticky.innerHTML = `
    <div class="sticky-header"></div>
    <div class="sticky-content" contenteditable="true">${content}</div>
    <button class="sticky-close">x</button>
  `;

  document.body.appendChild(sticky);

  const resizeObserver = new ResizeObserver(() => {
    saveStickyNotes();
  });
  resizeObserver.observe(sticky);

  applyStickyNoteTheme(sticky);
  makeStickyDraggable(sticky);

  const stickyContent = sticky.querySelector(".sticky-content");

  sticky.querySelector(".sticky-close").addEventListener("click", () => {
    sticky.remove();
    deleteStickyNote(id);
  });

  stickyContent.addEventListener("input", () => {
    saveStickyNotes();
  });

  saveStickyNotes();
}

function makeStickyDraggable(sticky) {
  const header = sticky.querySelector(".sticky-header");
  let isDragging = false;
  let offsetX = 0;
  let offsetY = 0;
  let debounceTimeout;

  header.addEventListener("mousedown", (e) => {
    isDragging = true;
    offsetX = e.clientX - sticky.offsetLeft;
    offsetY = e.clientY - sticky.offsetTop;
    sticky.style.zIndex = ++stickyIdCounter + 10000;
  });

  document.addEventListener("mousemove", (e) => {
    if (isDragging) {
      sticky.style.left = `${e.clientX - offsetX}px`;
      sticky.style.top = `${e.clientY - offsetY}px`;

      clearTimeout(debounceTimeout);
      debounceTimeout = setTimeout(() => {
        saveStickyNotes();
      }, 500);
    }
  });

  document.addEventListener("mouseup", () => {
    isDragging = false;
  });
}

function saveStickyNotes() {
  const stickies = document.querySelectorAll(".sticky-note");
  const data = [];

  stickies.forEach((sticky) => {
    const id = sticky.id;
    const left = Number.parseInt(sticky.style.left, 10);
    const top = Number.parseInt(sticky.style.top, 10);
    const content = sticky.querySelector(".sticky-content").innerHTML; // Changed from .value to .innerHTML

    // Get the actual CSS width and height instead of offsetWidth/offsetHeight
    const width = Number.parseInt(sticky.style.width, 10) || 200;
    const height = Number.parseInt(sticky.style.height, 10) || 150;

    data.push({ id, left, top, content, width, height });
  });

  localStorage.setItem("stickyNotes", JSON.stringify(data));
}

function deleteStickyNote(id) {
  const stickies = JSON.parse(localStorage.getItem("stickyNotes")) || [];
  const filtered = stickies.filter((note) => note.id !== id);
  localStorage.setItem("stickyNotes", JSON.stringify(filtered));
}

function applyStickyNoteTheme(sticky) {
  const isDark = isDarkMode;
  sticky.style.backgroundColor = isDark ? "#121212" : "#ffffff";
  sticky.style.border = isDark ? "1px solid #ffffff" : "1px solid #121212";
  sticky.style.color = isDark ? "#ffffff" : "#121212";

  const closeBtn = sticky.querySelector(".sticky-close");
  if (closeBtn) closeBtn.style.color = isDark ? "#ffffff" : "#121212";

  const content = sticky.querySelector(".sticky-content"); // Changed from .sticky-textarea
  if (content) {
    content.style.backgroundColor = isDark ? "#121212" : "#ffffff";
    content.style.color = isDark ? "#ffffff" : "#121212";
    content.style.border = "none";
    content.style.outline = "none";
  }
}

function darkUI() {
  textArea.style.color = "#FFFFFF";
  pageBody.style.backgroundColor = "#121212";
  sideBar.style.backgroundColor = "#121212";
  sideBar.style.outline = "1.5px solid white";

  dropDown.style.color = "#FFFFFF";
  dropDown.style.backgroundColor = "#121212";
  fontSidebar.style.outline = "1.5px solid #FFFFFF";
  fontSidebar.style.backgroundColor = "#121212";

  sideButton.forEach((btn) => {
    btn.style.color = "#FFFFFF";
  });

  document.querySelectorAll(".sticky-note").forEach((el) => {
    applyStickyNoteTheme(el);
  });
}

function lightUI() {
  textArea.style.color = "#121212";
  pageBody.style.backgroundColor = "#FFFFFF";
  sideBar.style.backgroundColor = "#FFFFFF";
  sideBar.style.outline = "2px solid black";

  dropDown.style.color = "#121212";
  dropDown.style.backgroundColor = "#FFFFFF";
  fontSidebar.style.outline = "2px solid #121212";
  fontSidebar.style.backgroundColor = "#FFFFFF";

  sideButton.forEach((btn) => {
    btn.style.color = "#121212";
  });

  document.querySelectorAll(".sticky-note").forEach((el) => {
    applyStickyNoteTheme(el);
  });
}

// function for downloading text, courtesy of filesaver (https://github.com/eligrey/FileSaver.js)
function downloadTxt() {
  var blob = new Blob([textArea.innerText], {
    type: "text/plain;charset=utf-8",
  });
  saveAs(blob, "newtab.txt");
}

function toggleDarkMode() {
  isDarkMode = !isDarkMode;
  localStorage.setItem("isDarkMode", isDarkMode);

  if (isDarkMode) {
    darkUI();
  } else {
    lightUI();
  }
}

function toggleBlur() {
  if (isBlur) {
    pageBody.classList.remove("blur");
  } else {
    pageBody.classList.add("blur");
  }
  isBlur = !isBlur;
  localStorage.setItem("isBlur", isBlur);
}

function main() {
  getData();
  attachEventListeners();

  window.addEventListener("DOMContentLoaded", () => {
    textArea.addEventListener("input", () => {
      localStorage.setItem("textareaValue", textArea.innerHTML);
    });

    document.querySelectorAll("[contenteditable]").forEach((el) => {
      el.addEventListener("keydown", (e) => {
        if (e.key === "Tab") {
          e.preventDefault();
          document.execCommand("insertText", false, "\t"); // 4 spaces
        }
      });
    });

    document.querySelectorAll("[contenteditable]").forEach((el) => {
      el.addEventListener("paste", async (e) => {
        e.preventDefault();
        const items = e.clipboardData.items;
        for (const item of items) {
          if (item.type.indexOf("image") !== -1) {
            const blob = item.getAsFile();
            const reader = new FileReader();
            reader.onload = (event) => {
              document.execCommand("insertImage", false, event.target.result);
            };
            reader.readAsDataURL(blob);
          } else if (item.type === "text/plain") {
            item.getAsString((text) => {
              const html = text
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/\t/g, "&emsp;")
                .replace(/ {2}/g, "&nbsp;&nbsp;") // handles double spaces
                .replace(/\n/g, "<br>");
              document.execCommand("insertHTML", false, html);
            });
          }
        }
      });
    });

    // keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey) {
        if (e.shiftKey && e.key === "Q") {
          toggleDarkMode();
        }

        if (e.key === "q") {
          toggleBlur();
        }

        if (e.key === "s") {
          e.preventDefault();
          downloadTxt();
        }

        if (e.key === "e") {
          e.preventDefault();
          createStickyNote();
        }
      }
    });
  });
}

main();
